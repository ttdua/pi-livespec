import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { registerBuiltinChecks, runChecks } from "../../src/engine/checks.ts";
import { createGit, type Git } from "../../src/engine/git.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { checkNames, registerCheck, resetRegistryForTests } from "../../src/engine/registry.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";

const BUILTIN = ["spec-format", "units-format", "done-maps-scenarios", "capabilities-match-diff"];
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
	test("registers the four LS-02 checks", () => {
		expect(checkNames().sort()).toEqual([...BUILTIN].sort());
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
		expect(called).toEqual(["units-format", "done-maps-scenarios"]);
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
