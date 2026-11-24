import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { registerBuiltinRules } from "../../src/decide/registry.ts";
import { registerBuiltinChecks, runChecks } from "../../src/engine/checks.ts";
import { createGit, type Git } from "../../src/engine/git.ts";
import type { CheckResult } from "../../src/engine/state-types.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { checkNames, clearGateMemo, gateMemoGeneration, isGateOnly, onGateMemoClear, registerCheck, resetRegistryForTests } from "../../src/engine/registry.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { decisionComment, type DecisionRecord } from "../../src/decide/records.ts";
import { type MarkedComment, parseMarked } from "../../src/forge/markers.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";

const BUILTIN = ["spec-format", "units-format", "done-maps-scenarios", "capabilities-match-diff", "unit-classification", "verify-red-on-base", "review-clean", "durable-docs", "size-limits", "product-impact", "glossary-terms", "behavior-change"];
const VALID_SPEC = readFileSync(new URL("../fixtures/rate-limit.spec.md", import.meta.url), "utf8");
const EMPTY_SPEC = "# broken\n\n## Purpose\nNothing.\n\n## Requirements\n";

/** Never called: tests that pass it do not reach git. */
const NO_GIT = {} as Git;

const U2_WITHOUT_VERIFY = `### U2 — Header parsing
Covers: request-context/Requirement: Client IP
Difficulty: low
Tags: []
Files: src/headers.ts
Done means:
- [hdr] the forwarded header is parsed
Scenarios:
- [hdr] test/headers.test.ts › parses header
Depends: U1
- [ ] pending

`;

let pack: Pack;

beforeEach(async () => {
	resetRegistryForTests();
	registerBuiltinRules();
	registerBuiltinChecks();
	const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
	if (!loaded.ok) throw new Error("default pack must load");
	pack = loaded.pack;
});

function withU2(body: string): string {
	return body.replace("### U3 —", `${U2_WITHOUT_VERIFY}### U3 —`);
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("registerBuiltinChecks", () => {
	test("registers the LS-02 checks and unit-classification", () => {
		expect(checkNames().sort()).toEqual([...BUILTIN].sort());
	});
});

describe("review-clean", () => {
	test("is gate-only and refuses the review gate when no round reviewed HEAD", async () => {
		expect(isGateOnly("review-clean")).toBe(true);
		const fake = { head: async () => "d4", diff: async () => "", diffNames: async () => [] } as unknown as Git;
		const state = stateFor("review");
		expect(await runChecks(pack, state, { root: "/nowhere", git: fake })).toEqual([]);
		const gated = await runChecks(pack, state, { root: "/nowhere", git: fake }, { gate: true, target: "review" });
		expect(gated).toEqual([expect.objectContaining({ check: "review-clean", severity: "error" })]);
	});
});

describe("runChecks", () => {
	test("Units check in plan", async () => {
		const state = stateFor("plan", { change: parseChange(withU2(FIXTURE_BODY)) });
		const results = await runChecks(pack, state, { root: "/nowhere", git: NO_GIT });
		const u2 = results.filter((r) => r.code === "units-format" && r.section === "U2");
		expect(u2.map((r) => r.message)).toContain("U2: missing field Verify");
	});

	test("Only active phase checks", async () => {
		const called: string[] = [];
		for (const name of BUILTIN) registerCheck(name, async () => (called.push(name), []));
		expect(await runChecks(pack, stateFor("shape"), { root: "/nowhere", git: NO_GIT })).toEqual([]);
		expect(called).toEqual([]);
		await runChecks(pack, stateFor("plan"), { root: "/nowhere", git: NO_GIT });
		expect(called).toEqual(["units-format", "done-maps-scenarios", "unit-classification", "verify-red-on-base", "size-limits"]);
	});

	test("passes the pack limits to the checks", async () => {
		let seen: unknown;
		registerCheck("size-limits", async (ctx) => ((seen = ctx.limits), []));
		await runChecks(pack, stateFor("plan"), { root: "/nowhere", git: NO_GIT });
		expect(seen).toEqual({ max_units: 8, max_capabilities: 3 });
	});

	test("no check runs without a single phase", async () => {
		const state = stateFor("plan", { phase: { kind: "missing" } });
		expect(await runChecks(pack, state, { root: "/nowhere", git: NO_GIT })).toEqual([]);
	});

	test("Capabilities mismatch", async () => {
		const root = await makeRepo();
		await writeIn(root, "README.md", "x\n");
		commitAll(root);
		const base = git(root, "rev-parse", "HEAD");
		await writeIn(root, "specs/auth/spec.md", VALID_SPEC.replace("# rate-limit", "# auth"));
		commitAll(root, "auth only");
		const body = FIXTURE_BODY.replace(/^Base: .*$/m, `Base: ${base}`);
		const state = stateFor("define", { change: parseChange(body) });
		const results = await runChecks(pack, state, { root, git: createGit(root) });
		const mismatch = results.filter((r) => r.code === "capabilities-match-diff").map((r) => r.message);
		expect(mismatch).toEqual([
			"Capability rate-limit is declared but the diff does not touch specs/rate-limit/",
			"Capability auth is touched by the diff but not declared",
		]);
	});

	test("capabilities-match-diff reports an unknown Base as an error result", async () => {
		const root = await makeRepo();
		await writeIn(root, "README.md", "x\n");
		commitAll(root);
		const only = { ...pack, phases: pack.phases.map((p) => (p.id === "define" ? { ...p, checks: ["capabilities-match-diff"] } : p)) };
		const results = await runChecks(only, stateFor("define"), { root, git: createGit(root) });
		expect(results).toEqual([
			expect.objectContaining({ code: "capabilities-match-diff", severity: "error", message: expect.stringContaining("cannot diff specs/ from Base 0123456789abcdef") }),
		]);
	});

	test("spec-format validates declared capabilities only", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/rate-limit/spec.md", EMPTY_SPEC);
		await writeIn(root, "specs/auth/spec.md", EMPTY_SPEC);
		commitAll(root);
		const base = git(root, "rev-parse", "HEAD");
		const body = FIXTURE_BODY.replace(/^Base: .*$/m, `Base: ${base}`);
		const state = stateFor("define", { change: parseChange(body) });
		const results = await runChecks(pack, state, { root, git: createGit(root) });
		const spec = results.filter((r) => r.file?.startsWith("specs/"));
		expect(spec.map((r) => [r.code, r.file])).toEqual([["spec-no-requirements", "specs/rate-limit/spec.md"]]);
	});

	test("spec-format reports a missing spec file", async () => {
		const root = await makeRepo();
		const results = await runChecks(
			{ ...pack, phases: pack.phases.map((p) => (p.id === "define" ? { ...p, checks: ["spec-format"] } : p)) },
			stateFor("define"),
			{ root, git: NO_GIT },
		);
		expect(results).toEqual([
			{ check: "spec-format", code: "spec-missing", severity: "error", file: "specs/rate-limit/spec.md", message: "specs/rate-limit/spec.md does not exist" },
		]);
	});

	test("a result's own check field cannot override the registered name", async () => {
		const spoofed = { check: "spoof", code: "x", severity: "error" as const, message: "m" };
		registerCheck("honest", async () => [spoofed]);
		const custom = { ...pack, phases: pack.phases.map((p) => (p.id === "plan" ? { ...p, checks: ["honest"] } : p)) };
		const results = await runChecks(custom, stateFor("plan"), { root: "/nowhere", git: NO_GIT });
		expect(results).toEqual([{ check: "honest", code: "x", severity: "error", message: "m" }]);
	});

	test("a throwing check becomes a check-failed error result and later checks still run", async () => {
		registerCheck("explodes", async () => {
			throw new Error("boom");
		});
		registerCheck("after", async () => [{ code: "ok", severity: "warning", message: "ran" }]);
		const custom = { ...pack, phases: pack.phases.map((p) => (p.id === "plan" ? { ...p, checks: ["explodes", "after"] } : p)) };
		const results = await runChecks(custom, stateFor("plan"), { root: "/nowhere", git: NO_GIT });
		expect(results).toEqual([
			{ check: "explodes", code: "check-failed", severity: "error", message: "Check explodes failed: boom" },
			{ check: "after", code: "ok", severity: "warning", message: "ran" },
		]);
	});

	test("results are tagged with the named check that produced them", async () => {
		registerCheck("depends-merged", async () => [{ code: "dep-open", severity: "error", message: "Change #34 is not merged." }]);
		const custom = { ...pack, phases: pack.phases.map((p) => (p.id === "plan" ? { ...p, checks: ["depends-merged", "units-format", "not-registered"] } : p)) };
		const state = stateFor("plan", { change: parseChange(withU2(FIXTURE_BODY)) });
		const results = await runChecks(custom, state, { root: "/nowhere", git: NO_GIT });
		expect(results[0]).toEqual({ check: "depends-merged", code: "dep-open", severity: "error", message: "Change #34 is not merged." });
		expect(results.filter((r) => r.code === "units-format").every((r) => r.check === "units-format")).toBe(true);
		expect(results.at(-1)).toEqual(expect.objectContaining({ check: "not-registered", code: "check-unregistered" }));
	});
});

/** A `decision` comment as `filterMarked` returns it, from the real comment body. */
function decisionMarked(r: DecisionRecord): MarkedComment {
	const parsed = parseMarked(decisionComment(r));
	if (!parsed) throw new Error("decision comment does not parse");
	return { commentId: `c-${r.point}-${r.subject}`, author: "bot", ...parsed };
}

/** Rule records matching the fixture body: U1 low with no tags, U3 medium with `[security, api]`. */
function fixtureRecords(body = FIXTURE_BODY): MarkedComment[] {
	const units = parseChange(body).units;
	const record = (point: string, unit: string, outcome: unknown): MarkedComment => {
		const u = units.find((x) => x.id === unit);
		if (!u) throw new Error(`no unit ${unit}`);
		return decisionMarked({ point, subject: unit, digest: unitDigest(u), source: "rule", outcome, reason: `${point} rule` });
	};
	return [
		record("tags", "U1", []),
		record("difficulty", "U1", "low"),
		record("tags", "U3", ["security", "api"]),
		record("difficulty", "U3", "medium"),
	];
}

async function classification(body: string, marked: MarkedComment[]): Promise<CheckResult[]> {
	const state = stateFor("plan", { change: parseChange(body), marked });
	const results = await runChecks(pack, state, { root: "/nowhere", git: NO_GIT });
	return results.filter((r) => r.check === "unit-classification");
}

describe("unit-classification", () => {
	test("matching records pass", async () => {
		expect(await classification(FIXTURE_BODY, fixtureRecords())).toEqual([]);
	});

	test("Tag removed in the body", async () => {
		const edited = FIXTURE_BODY.replace("Tags: [security, api]", "Tags: [api]");
		const results = await classification(edited, fixtureRecords());
		expect(results).toEqual([
			{
				check: "unit-classification",
				code: "unit-classification",
				severity: "error",
				section: "U3",
				message: "U3: Tags [api] does not match the tags decision [security, api]",
			},
		]);
	});

	test("unit without a record is an error", async () => {
		const results = await classification(FIXTURE_BODY, fixtureRecords().filter((m) => m.id !== "difficulty.U1"));
		expect(results.map((r) => [r.section, r.message])).toEqual([["U1", "U1: no difficulty decision record for its current contract"]]);
	});

	test("record for a digest not in the body is ignored", async () => {
		const stale = decisionMarked({ point: "tags", subject: "U3", digest: "0".repeat(64), source: "human", outcome: ["perf"], reason: "older contract" });
		expect(await classification(FIXTURE_BODY, [...fixtureRecords(), stale])).toEqual([]);
		const onlyStale = fixtureRecords().filter((m) => m.id !== "tags.U3");
		const results = await classification(FIXTURE_BODY, [...onlyStale, stale]);
		expect(results.map((r) => r.message)).toEqual(["U3: no tags decision record for its current contract"]);
	});

	test("check context carries the own marked comments", async () => {
		let seen: MarkedComment[] | undefined;
		registerCheck("peek", async (ctx) => ((seen = ctx.marked), []));
		const custom = { ...pack, phases: pack.phases.map((p) => (p.id === "plan" ? { ...p, checks: ["peek"] } : p)) };
		const marked = fixtureRecords();
		await runChecks(custom, stateFor("plan", { marked }), { root: "/nowhere", git: NO_GIT });
		expect(seen).toBe(marked);
	});
});

describe("gate-only checks", () => {
	function withSlow(): Pack {
		return { ...pack, phases: pack.phases.map((p) => (p.id === "plan" ? { ...p, checks: ["slow"] } : p)) };
	}
	const slowResult = { code: "slow", severity: "error" as const, message: "slow failed" };
	let calls = 0;
	let key = "k";
	beforeEach(() => {
		calls = 0;
		key = "k";
		registerCheck("slow", async () => (calls++, [slowResult]), { at: "gate", key: () => key });
	});
	const run = (opts?: { gate?: boolean; target?: string }) => runChecks(withSlow(), stateFor("plan"), { root: "/nowhere", git: NO_GIT }, opts);

	test("Gate-only check skipped on refresh", async () => {
		expect(await run()).toEqual([]);
		expect(await run()).toEqual([]);
		expect(calls).toBe(0);
		expect(isGateOnly("slow")).toBe(true);
	});

	test("a gate run stores results that a refresh with the same key returns", async () => {
		const gated = await run({ gate: true, target: "plan" });
		expect(gated).toEqual([{ ...slowResult, check: "slow" }]);
		expect(await run()).toEqual(gated);
		expect(calls).toBe(1);
	});

	test("a refresh with another key returns none", async () => {
		await run({ gate: true, target: "plan" });
		key = "other";
		expect(await run()).toEqual([]);
		expect(calls).toBe(1);
	});

	test("a gate run of another target does not run the check", async () => {
		expect(await run({ gate: true, target: "build" })).toEqual([]);
		expect(calls).toBe(0);
	});

	test("results of a check that finishes after clearGateMemo are not stored", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		registerCheck("slow", async () => (await gate, [slowResult]), { at: "gate", key: () => key });
		const pending = run({ gate: true, target: "plan" });
		clearGateMemo();
		release();
		await pending;
		expect(await run()).toEqual([]);
	});

	test("clearGateMemo drops stored results, bumps the generation and calls listeners", async () => {
		await run({ gate: true, target: "plan" });
		let called = 0;
		onGateMemoClear(() => called++);
		const before = gateMemoGeneration();
		clearGateMemo();
		expect(gateMemoGeneration()).toBe(before + 1);
		expect(called).toBe(1);
		expect(await run()).toEqual([]);
	});
});
