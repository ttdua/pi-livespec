import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { glossaryTermsCheck } from "../../src/docs/glossary-terms.ts";
import { registerBuiltinRules } from "../../src/decide/registry.ts";
import "../../src/deps/markers.ts";
import { registerBuiltinChecks } from "../../src/engine/checks.ts";
import { collectReviewFacts, gatePayload } from "../../src/engine/gate-payload.ts";
import { resetGatesForTests } from "../../src/engine/gates.ts";
import { createGit } from "../../src/engine/git.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { resetRegistryForTests } from "../../src/engine/registry.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";

let pack: Pack;
beforeEach(async () => {
	resetRegistryForTests();
	resetGatesForTests();
	registerBuiltinRules();
	registerBuiltinChecks();
	const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
	if (!loaded.ok) throw new Error("default pack must load");
	pack = loaded.pack;
});

const SPEC = (body: string) => `---\ncapability: x\npaths: [src/**]\n---\n\n${body}\n`;

async function repoWithSpecsDiff(): Promise<{ root: string; base: string }> {
	const root = await makeRepo();
	await writeIn(root, "specs/auth/spec.md", SPEC("The Gateway authenticates."));
	await writeIn(root, "specs/glossary.md", "# Glossary\n");
	commitAll(root, "base");
	const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	await writeIn(root, "specs/rate/spec.md", SPEC("Requests go through the Gateway and the Router.\nEach **Token bucket** refills."));
	await writeIn(root, "specs/glossary.md", "# Glossary\n\n- **Token bucket**: a refilling request budget\n");
	commitAll(root, "spec");
	return { root, base };
}

describe("glossary-terms at the gate", () => {
	test("known at Base in another spec", async () => {
		const { root, base } = await repoWithSpecsDiff();
		const change = parseChange(`Base: ${base}\nCapabilities: new [rate], modified []\n`);
		const out = await glossaryTermsCheck({ root, change, git: createGit(root), marked: [] });
		expect(out.map((r) => r.message).join("\n")).toContain("Router");
		expect(out.map((r) => r.message).join("\n")).not.toContain("Gateway");
		expect(out.every((r) => r.severity === "warning")).toBe(true);
	});

	test("Proposed entries shown at the gate", async () => {
		const { root, base } = await repoWithSpecsDiff();
		const facts = await collectReviewFacts(createGit(root), base);
		const state = stateFor("define", {
			checks: [{ check: "glossary-terms", code: "glossary-terms", severity: "warning", message: 'New term "Router" has no entry in specs/glossary.md' }],
		}, FIXTURE_BODY);
		const summary = gatePayload(state, pack, "define", facts).summary;
		expect(summary).toContain("Glossary:");
		expect(summary).toContain("- **Token bucket**: a refilling request budget");
		expect(summary).toContain("Router");
	});

	test("no Glossary section without warnings or entries", () => {
		const facts = { specsStat: "", specsFiles: [], specsDiff: "" };
		expect(gatePayload(stateFor("define"), pack, "define", facts).summary).not.toContain("Glossary:");
	});
});
