import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerBuiltinRules } from "../../src/decide/registry.ts";
import type { TagsConfig } from "../../src/decide/rules/tags.ts";
import { defaultPackPath, loadPack } from "../../src/engine/pack-load.ts";
import type { LoadedPack } from "../../src/engine/pack-types.ts";
import { registerCheck, resetRegistryForTests } from "../../src/engine/registry.ts";

const fixture = JSON.parse(
	readFileSync(new URL("../fixtures/agent-skills.pack.json", import.meta.url), "utf8"),
) as unknown;

const OVERRIDE = "/proj/.pi/livespec/flow.yaml";

function withOverride(text: string | undefined) {
	return {
		async readFile(p: string): Promise<string | undefined> {
			return p === OVERRIDE ? text : undefined;
		},
	};
}

async function load(text?: string): Promise<LoadedPack> {
	return loadPack("/proj", withOverride(text));
}

function okPack(r: LoadedPack) {
	if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);
	return r.pack;
}

function phase(r: LoadedPack, id: string) {
	const p = okPack(r).phases.find((x) => x.id === id);
	if (!p) throw new Error(`no phase ${id}`);
	return p;
}

beforeEach(() => {
	resetRegistryForTests();
	registerBuiltinRules();
	for (const name of ["spec-format", "units-format", "done-maps-scenarios", "capabilities-match-diff", "unit-classification", "verify-red-on-base"]) {
		registerCheck(name, async () => []);
	}
});

describe("default pack", () => {
	test("default pack validates without stub checks", async () => {
		// A fresh module graph has an empty registry: only pack-load's own imports can register the checks.
		vi.resetModules();
		const fresh = await import("../../src/engine/pack-load.ts");
		const r = await fresh.loadPack("/proj", withOverride(undefined));
		expect(r.ok).toBe(true);
	});

	test("default pack build entries validate", async () => {
		const r = await load();
		expect(r.ok).toBe(true);
		expect(phase(r, "build").subagents).toEqual([
			{ role: "implementer", mode: "auto", when: ["units>=3", "difficulty>=medium", "context>=60%"] },
			{ role: "reviewer", subject: "unit", mode: "auto", when: ["difficulty>=medium"], skills: ["code-review-and-quality"] },
		]);
	});

	test("Default pack loads", async () => {
		const r = await load();
		expect(r.ok).toBe(true);
		const pack = okPack(r);
		expect(pack.name).toBe("agent-skills");
		expect(pack.phases.map((p) => p.id)).toEqual(["shape", "define", "plan", "build", "review", "ship", "close"]);
	});

	test("Default pack contents", async () => {
		expect(okPack(await load())).toEqual(fixture);
	});

	test("Spot check", async () => {
		const r = await load();
		const define = phase(r, "define");
		expect(define.requires).toEqual(["shape"]);
		expect(define.skills.required).toEqual(["spec-driven-development"]);
		expect(define.outputs).toEqual(["issue#Capabilities", "issue#Proposal", "specs-diff"]);
		expect(define.checks).toEqual(["spec-format", "capabilities-match-diff"]);
		expect(define.gate).toBe("human");
		expect(phase(r, "build").per).toBe("unit");
		expect(phase(r, "plan").checks).toEqual(["units-format", "done-maps-scenarios", "unit-classification", "verify-red-on-base"]);
		expect((okPack(r).decisions.difficulty as { mode: string }).mode).toBe("rule");
		expect((okPack(r).decisions.progress as { mode: string }).mode).toBe("rule");
	});

	test("Registered check name", async () => {
		registerCheck("extra-check", async () => []);
		const r = await load("extends: agent-skills\nphases:\n  - id: plan\n    checks: [extra-check]\n");
		expect(phase(r, "plan").checks).toEqual(["extra-check"]);
	});

	test("unregistered check in the default pack is an error", async () => {
		resetRegistryForTests();
		const r = await load();
		expect(r.ok).toBe(false);
	});
});

describe("override merge", () => {
	test("Replace one key", async () => {
		const r = await load("extends: agent-skills\nphases:\n  - id: plan\n    gate: self\n");
		const base = (fixture as { phases: { id: string }[] }).phases.find((p) => p.id === "plan");
		expect(phase(r, "plan")).toEqual({ ...base, gate: "self" });
	});

	test("Replace a skills list", async () => {
		const r = await load("extends: agent-skills\nphases:\n  - id: review\n    skills:\n      optional: [security-and-hardening]\n");
		const review = phase(r, "review");
		expect(review.skills.optional).toEqual(["security-and-hardening"]);
		expect(review.skills.required).toEqual(["code-review-and-quality"]);
	});

	test("Add a phase", async () => {
		const r = await load("extends: agent-skills\nphases:\n  - id: docs\n    requires: [review]\n");
		const pack = okPack(r);
		expect(pack.phases).toHaveLength(8);
		expect(pack.phases.at(-1)?.id).toBe("docs");
		expect(phase(r, "docs").gate).toBe("none");
	});

	test("Decisions merge through the rule", async () => {
		const r = await load("extends: agent-skills\ndecisions:\n  tags:\n    mode: rule\n    keywords:\n      perf: [p99]\n");
		const decisions = okPack(r).decisions;
		const tags = decisions.tags as TagsConfig;
		expect(tags.keywords.perf).toEqual(["performance", "latency", "throughput", "cache", "p99"]);
		expect(decisions.difficulty).toEqual((fixture as { decisions: { difficulty: unknown } }).decisions.difficulty);
	});

	test("tags path override adds globs per tag", async () => {
		const r = await load('extends: agent-skills\ndecisions:\n  tags:\n    mode: rule\n    paths:\n      security: ["**/crypto/**"]\n      infra: ["ops/**"]\n');
		const tags = okPack(r).decisions.tags as TagsConfig;
		expect(tags.mode).toBe("rule");
		expect(tags.paths.security).toEqual(["**/auth/**", "**/middleware/**", "**/crypto/**"]);
		expect(tags.paths.infra).toEqual(["ops/**"]);
		expect(tags.paths.ui).toEqual(["**/*.tsx", "**/*.jsx", "**/*.css", "**/*.vue", "**/*.svelte"]);
		expect(tags.keywords.api).toEqual(["endpoint", "public api"]);
		expect(okPack(r).decisions.difficulty).toEqual({ mode: "rule" });
	});

	test("tag named after an Object prototype key merges and loads", async () => {
		const r = await load("extends: agent-skills\ndecisions:\n  tags:\n    mode: rule\n    keywords:\n      constructor: [cache]\n      toString: [latency]\n");
		const tags = okPack(r).decisions.tags as TagsConfig;
		expect(tags.keywords.constructor).toEqual(["cache"]);
		expect(tags.keywords.toString).toEqual(["latency"]);
		expect(tags.keywords.perf).toEqual(["performance", "latency", "throughput", "cache"]);
	});

	test("override of a decision point without mode is an error", async () => {
		const r = await load("extends: agent-skills\ndecisions:\n  difficulty: {}\n");
		expect(r.ok).toBe(false);
	});

	test("override with mode jev is rejected at its position", async () => {
		const r = await load("extends: agent-skills\ndecisions:\n  tags:\n    mode: jev\n");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors[0]).toMatchObject({ file: ".pi/livespec/flow.yaml", line: 4, col: 11 });
	});

	test("Merge loops", async () => {
		const r = await load("extends: agent-skills\nloops: { review_rounds: 5 }\n");
		expect(okPack(r).loops).toEqual({ unit_attempts: 3, unit_rebuilds: 2, review_rounds: 5, change_iterations: 5, discovered_deps: 2 });
	});

	test("Error points at override", async () => {
		const r = await load("extends: agent-skills\nphases:\n  - id: plan\n    gate: maybe\n");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toMatchObject({ file: ".pi/livespec/flow.yaml", line: 4, col: 11 });
	});

	test("semantic error from an override points at the override node", async () => {
		const r = await load("extends: agent-skills\nphases:\n  - id: plan\n    requires: [ghost]\n");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors[0]).toMatchObject({ file: ".pi/livespec/flow.yaml", line: 4, col: 15 });
		expect(r.errors[0]?.message).toContain("ghost");
	});

	test("Requires cycle", async () => {
		const r = await load(
			"name: p\nversion: 1\ncontent: c\nphases:\n  - id: a\n    requires: [b]\n  - id: b\n    requires: [a]\n",
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toMatchObject({ file: ".pi/livespec/flow.yaml", line: 6, col: 15 });
		expect(r.errors[0]?.message).toBe("requires cycle: a -> b -> a");
	});

	test("duplicate phase id is an error", async () => {
		const r = await load("name: p\nversion: 1\ncontent: c\nphases:\n  - id: a\n  - id: a\n");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors[0]).toMatchObject({ line: 6, col: 9 });
	});

	test("excluded skills produce warnings", async () => {
		const r = await load("extends: agent-skills\nphases:\n  - id: shape\n    skills:\n      optional: [context-engineering]\n");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toMatchObject({ severity: "warning", file: ".pi/livespec/flow.yaml", line: 5, col: 18 });
	});
});

describe("override limits", () => {
	test("Unknown extends", async () => {
		const r = await load("extends: superpowers\n");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toMatchObject({ file: ".pi/livespec/flow.yaml", line: 1, col: 10 });
		expect(r.errors[0]?.message).toContain("superpowers");
	});

	test("Name changed", async () => {
		const r = await load("extends: agent-skills\nname: mine\n");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toMatchObject({ file: ".pi/livespec/flow.yaml", line: 2, col: 1 });
	});

	test("Standalone pack", async () => {
		const r = await load("name: mine\nversion: 1\ncontent: c\nphases:\n  - id: one\n  - id: two\n    requires: [one]\n");
		expect(okPack(r).phases.map((p) => p.id)).toEqual(["one", "two"]);
		expect(okPack(r).name).toBe("mine");
	});

	test("an unresolved alias in an override returns an error and does not reject", async () => {
		const r = await load("extends: agent-skills\nphases: *missing\n");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toMatchObject({ file: ".pi/livespec/flow.yaml", line: 2, col: 9 });
		expect(r.errors[0]?.message).toBe("`phases` must be a list");
	});

	test("empty override file reports a positioned error", async () => {
		const r = await load("");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors[0]).toMatchObject({ file: ".pi/livespec/flow.yaml", line: 1, col: 1 });
	});

	test("override with non-list phases reports an error", async () => {
		const r = await load("extends: agent-skills\nphases:\n  plan:\n    gate: self\n");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors[0]).toMatchObject({ line: 3, col: 3 });
	});
});

describe("default pack path", () => {
	test("resolves a module directory containing a space to a plain file path", async () => {
		expect(defaultPackPath("file:///tmp/my%20dir/src/engine/pack-load.ts")).toBe("/tmp/my dir/src/packs/agent-skills.yaml");
	});
});
