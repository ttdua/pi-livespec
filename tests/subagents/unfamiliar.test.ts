// Tests of the unfamiliar-code fact computed at refresh from the living specs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { readUnfamiliar } from "../../src/subagents/unfamiliar.ts";
import { FIXTURE_BODY } from "../helpers/change-state.ts";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function repo(specs: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "ls-unf-"));
	roots.push(root);
	for (const [capability, text] of Object.entries(specs)) {
		mkdirSync(join(root, "specs", capability), { recursive: true });
		writeFileSync(join(root, "specs", capability, "spec.md"), text);
	}
	return root;
}

const spec = (paths: string[]): string => `---\npaths: [${paths.join(", ")}]\n---\n# x\n\n## Purpose\np\n\n## Requirements\n`;

describe("readUnfamiliar", () => {
	test("a build unit whose file matches no capability path is unfamiliar; a covered one is not", async () => {
		const root = repo({ "rate-limit": spec(["src/middleware/**", "test/ratelimit*"]) });
		const found = await readUnfamiliar(root, "build", parseChange(FIXTURE_BODY));
		expect(found.units).toEqual({ U1: true, U3: false });
	});

	test("shape, define and plan: a declared capability without a spec path", async () => {
		const root = repo({ "rate-limit": spec([]) });
		expect((await readUnfamiliar(root, "plan", parseChange(FIXTURE_BODY))).change).toBe(true);
		const ok = repo({ "rate-limit": spec(["src/**"]) });
		expect((await readUnfamiliar(ok, "plan", parseChange(FIXTURE_BODY))).change).toBe(false);
	});

	test("no specs directory: unfamiliar", async () => {
		expect((await readUnfamiliar(repo({}), "shape", parseChange(FIXTURE_BODY))).change).toBe(true);
	});
});
