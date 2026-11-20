// Tests for the subagents pack policy: sub-schema validation, `when` conditions and the default pack entries.
import { readFileSync } from "node:fs";
import { LineCounter, type Node, type Pair, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Unit } from "../../src/core/change.ts";
import { parseSpec } from "../../src/core/spec.ts";
import { registerCheck, resetRegistryForTests } from "../../src/engine/registry.ts";
import {
	type PolicyFacts,
	entriesFor,
	holds,
	personas,
	registerSubagentsSchema,
	unfamiliarCode,
	validateSubagentsNode,
} from "../../src/subagents/policy.ts";
import type { SubagentEntry } from "../../src/subagents/roles.ts";

type Reported = { line: number; col: number; message: string };

function pairNamed(map: { items: Pair[] }, key: string): Pair | undefined {
	return map.items.find((p) => isScalar(p.key) && p.key.value === key);
}

/** Validates the `subagents` value of the `build` phase of a minimal pack; reports line and column. */
function errorsOf(yamlValue: string): Reported[] {
	const text = `name: p\nversion: 1\ncontent: c\nphases:\n  - id: build\n    subagents: ${yamlValue}\n`;
	const lc = new LineCounter();
	const doc = parseDocument(text, { lineCounter: lc });
	if (!isMap(doc.contents)) throw new Error("fixture is not a map");
	const phases = pairNamed(doc.contents, "phases")?.value;
	if (!isSeq(phases) || !isMap(phases.items[0])) throw new Error("fixture has no phase map");
	const subagents = pairNamed(phases.items[0], "subagents")?.value as Node | null;
	const out: Reported[] = [];
	validateSubagentsNode(subagents, (n, message) => {
		const { line, col } = lc.linePos(n.range?.[0] ?? 0);
		out.push({ line, col, message });
	});
	return out;
}

const BASE_FACTS: PolicyFacts = { units: 1, tags: [], unfamiliar: false, turnsCompleted: 1 };

function facts(over: Partial<PolicyFacts> = {}): PolicyFacts {
	return { ...BASE_FACTS, ...over };
}

function entry(over: Partial<SubagentEntry>): SubagentEntry {
	return { role: "implementer", mode: "auto", when: [], ...over };
}

function unit(over: Partial<Unit> = {}): Unit {
	return {
		id: "U1",
		title: "t",
		covers: [],
		files: [],
		doneMeans: [],
		scenarios: [],
		depends: [],
		done: false,
		statusLine: -1,
		statusText: "",
		startLine: 0,
		endLine: 0,
		raw: {},
		...over,
	};
}

function spec(capability: string, paths: string[]) {
	const list = paths.map((p) => `"${p}"`).join(", ");
	return parseSpec(`---\npaths: [${list}]\n---\n# ${capability}\n\n## Purpose\n\nx\n`, capability);
}

beforeEach(() => {
	resetRegistryForTests();
	registerCheck("known", async () => []);
	registerSubagentsSchema();
});

describe("subagents sub-schema", () => {
	test("valid entry", () => {
		expect(errorsOf('[{ role: reviewer, subject: unit, mode: auto, when: ["difficulty>=medium"] }]')).toEqual([]);
	});

	test("reviewer without subject", () => {
		const errors = errorsOf("[{ role: reviewer, mode: always }]");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ line: 6, col: 17 });
		expect(errors[0]?.message).toContain("subject");
	});

	test("model key rejected", () => {
		const errors = errorsOf("[{ role: implementer, mode: always, model: x }]");
		expect(errors.some((e) => e.message.includes("packs never name models"))).toBe(true);
	});

	test("when requires auto", () => {
		const errors = errorsOf('[{ role: implementer, mode: always, when: ["units>=3"] }]');
		expect(errors.some((e) => e.message.includes("auto"))).toBe(true);
	});

	test("auto without when is an error", () => {
		const errors = errorsOf("[{ role: implementer, mode: auto }]");
		expect(errors.some((e) => e.message.includes("when"))).toBe(true);
	});

	test("unparsable condition is an error", () => {
		const errors = errorsOf('[{ role: implementer, mode: auto, when: ["bogus>=2"] }]');
		expect(errors.length).toBeGreaterThan(0);
	});

	test("advisory must be a boolean", () => {
		const errors = errorsOf("[{ role: reviewer, subject: spec, mode: always, advisory: nope }]");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ line: 6, col: 74 });
		expect(errors[0]?.message).toContain("advisory");
	});

	test("skills must be a list of strings", () => {
		const errors = errorsOf("[{ role: implementer, mode: always, skills: 42 }]");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ line: 6, col: 60 });
		expect(errors[0]?.message).toContain("skills");
	});

	test("skills entries must be strings", () => {
		expect(errorsOf("[{ role: implementer, mode: always, skills: [{ a: 1 }] }]")).toHaveLength(1);
	});

	test("when must be a list", () => {
		const errors = errorsOf("[{ role: implementer, mode: auto, when: units>=3 }]");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ line: 6, col: 56 });
		expect(errors[0]?.message).toContain("`when` must be a list");
	});

	test("persona subjects are reported as personas", () => {
		expect(personas([{ role: "reviewer", subject: "persona:security", mode: "always" }])).toEqual(["security"]);
	});
});

describe("when conditions", () => {
	test("unfamiliar code in build", () => {
		const specs = [spec("auth", ["src/auth/**"])];
		expect(unfamiliarCode("build", unit({ files: ["src/new/x.ts"] }), specs, ["auth"])).toBe(true);
		expect(unfamiliarCode("build", unit({ files: ["src/auth/a.ts"] }), specs, ["auth"])).toBe(false);
	});

	test("unfamiliar code in plan with no unit: a capability has no spec", () => {
		const specs = [spec("auth", ["src/auth/**"])];
		expect(unfamiliarCode("plan", undefined, specs, ["auth", "billing"])).toBe(true);
	});

	test("unfamiliar code in plan with no unit: a spec has paths []", () => {
		const specs = [spec("auth", ["src/auth/**"]), spec("billing", [])];
		expect(unfamiliarCode("define", undefined, specs, ["auth", "billing"])).toBe(true);
	});

	test("no unfamiliar code in plan when every capability has a spec with paths", () => {
		const specs = [spec("auth", ["src/auth/**"]), spec("billing", ["src/billing/**"])];
		expect(unfamiliarCode("plan", undefined, specs, ["auth", "billing"])).toBe(false);
	});

	test("unfamiliar code in shape when the repository has no specs", () => {
		expect(unfamiliarCode("shape", undefined, [], [])).toBe(true);
	});

	test("context threshold with margin", () => {
		expect(holds(entry({ when: ["context>=60%"] }), facts({ contextPercent: 58.5 }))).toBe(true);
	});

	test("first turn never holds", () => {
		expect(holds(entry({ when: ["context>=60%"] }), facts({ contextPercent: 99, turnsCompleted: 0 }))).toBe(false);
	});
});

describe("default pack", () => {
	test("default pack build entries validate", async () => {
		// A fresh module graph: pack-load registers its own checks and the subagents schema on import.
		vi.resetModules();
		const fresh = await import("../../src/engine/pack-load.ts");
		const loaded = await fresh.loadPack("/proj", { readFile: async () => undefined });
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(entriesFor(loaded.pack, "build")).toEqual([
			{ role: "implementer", mode: "auto", when: ["units>=3", "difficulty>=medium", "context>=60%"] },
			{ role: "reviewer", subject: "unit", mode: "auto", when: ["difficulty>=medium"], skills: ["code-review-and-quality"] },
		]);
	});
});

describe("Review entries", () => {
	test("personas reports the four reviewer names of the review phase", () => {
		const pack = JSON.parse(readFileSync(new URL("../fixtures/agent-skills.pack.json", import.meta.url), "utf8")) as { phases: { id: string; subagents: unknown[] }[] };
		expect(personas(pack.phases.find((p) => p.id === "review")?.subagents)).toEqual(["code-reviewer", "security-auditor", "web-performance-auditor", "test-engineer"]);
	});

	test("a change subject needs code-reviewer", () => {
		expect(personas([{ role: "reviewer", subject: "change", mode: "always" }])).toEqual(["code-reviewer"]);
	});
});
