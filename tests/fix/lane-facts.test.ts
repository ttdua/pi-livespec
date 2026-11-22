import { describe, expect, test } from "vitest";
import { fixMergeBase } from "../../src/fix/branch.ts";
import { laneFacts } from "../../src/fix/lane-facts.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { type Fixture, fixture, sh, upstreamCommit } from "../ship/repo.ts";

const SPEC = `---
paths: [src/forge/**]
---
# forge-read

## Purpose
Read the forge.

## Requirements

### Requirement: Read cache
The system SHALL cache reads.

#### Scenario: Fresh cache
- **WHEN** a read is cached
- **THEN** it is served

#### Scenario: Stale cache
- **WHEN** the cache is stale
- **THEN** it is refreshed
`;

/** A fixture whose main carries `specs/forge-read/spec.md` and `src/forge/read.ts`, with HEAD on `fix/typo`. */
async function specRepo(): Promise<Fixture> {
	const f = await fixture();
	await writeIn(f.upstream, "specs/forge-read/spec.md", SPEC);
	await writeIn(f.upstream, "src/forge/read.ts", "export const a = 1;\n");
	commitAll(f.upstream, "seed specs");
	sh(f.upstream, "push", "-q", "origin", "HEAD:main");
	sh(f.work, "fetch", "-q", "origin", "main");
	sh(f.work, "checkout", "-q", "-b", "fix/typo", "origin/main");
	return f;
}

async function factsOf(f: Fixture) {
	return laneFacts(f.git, f.work, await fixMergeBase(f.git, "main"));
}

describe("laneFacts", () => {
	test("Added requirement forces", async () => {
		const f = await specRepo();
		await writeIn(f.work, "specs/forge-read/spec.md", `${SPEC}\n### Requirement: Retry budget\nThe system SHALL retry.\n`);
		commitAll(f.work, "add req");
		const facts = await factsOf(f);
		expect(facts.spec_changes).toEqual([{ capability: "forge-read", added_requirements: ["Retry budget"], removed_requirements: [], scenarios: [] }]);
		expect(facts.files).toEqual(["specs/forge-read/spec.md"]);
		expect(facts.lines).toBe(3);
	});

	test("Small fix: editing scenario text only gives an entry with empty lists", async () => {
		const f = await specRepo();
		await writeIn(f.work, "specs/forge-read/spec.md", SPEC.replace("it is served", "it is served from memory"));
		await writeIn(f.work, "src/forge/read.ts", "export const a = 2;\n");
		commitAll(f.work, "edit");
		const facts = await factsOf(f);
		expect(facts.spec_changes).toEqual([{ capability: "forge-read", added_requirements: [], removed_requirements: [], scenarios: [] }]);
		expect(facts.files.sort()).toEqual(["specs/forge-read/spec.md", "src/forge/read.ts"]);
		expect(facts.lines).toBe(4);
		expect(facts.created_capabilities).toEqual([]);
		expect(facts.governance).toEqual([]);
		expect(facts.capability_code).toEqual([{ capability: "forge-read", files: ["src/forge/read.ts"], spec_changed: true }]);
	});

	test("Removed scenario forces", async () => {
		const f = await specRepo();
		await writeIn(f.work, "specs/forge-read/spec.md", SPEC.replace(/\n#### Scenario: Stale cache[\s\S]*$/, "\n"));
		commitAll(f.work, "drop scenario");
		const facts = await factsOf(f);
		expect(facts.spec_changes).toEqual([
			{ capability: "forge-read", added_requirements: [], removed_requirements: [], scenarios: [{ requirement: "Read cache", added: [], removed: ["Stale cache"] }] },
		]);
	});

	test("a renamed scenario is one removal and one addition", async () => {
		const f = await specRepo();
		await writeIn(f.work, "specs/forge-read/spec.md", SPEC.replace("Scenario: Stale cache", "Scenario: Expired cache"));
		commitAll(f.work, "rename scenario");
		const facts = await factsOf(f);
		expect(facts.spec_changes[0]?.scenarios).toEqual([{ requirement: "Read cache", added: ["Expired cache"], removed: ["Stale cache"] }]);
	});

	test("a rename counts once in files", async () => {
		const f = await specRepo();
		sh(f.work, "mv", "src/forge/read.ts", "src/forge/fetch.ts");
		commitAll(f.work, "rename");
		const facts = await factsOf(f);
		expect(facts.files).toEqual(["src/forge/fetch.ts"]);
		expect(facts.lines).toBe(0);
	});

	test("spec deleted on the fix branch forces", async () => {
		const f = await specRepo();
		sh(f.work, "rm", "-q", "specs/forge-read/spec.md");
		commitAll(f.work, "delete spec");
		const facts = await factsOf(f);
		expect(facts.spec_changes).toEqual([{ capability: "forge-read", added_requirements: [], removed_requirements: ["Read cache"], scenarios: [] }]);
	});

	test("a spec or governance file renamed away still counts its old path", async () => {
		const f = await specRepo();
		await writeIn(f.upstream, "specs/constraints.md", "# constraints\n\nkeep it\n");
		commitAll(f.upstream, "constraints");
		sh(f.upstream, "push", "-q", "origin", "HEAD:main");
		sh(f.work, "pull", "-q", "--ff-only", "origin", "main");
		sh(f.work, "mv", "specs/forge-read/spec.md", "specs/forge-read.md");
		sh(f.work, "mv", "specs/constraints.md", "constraints.md");
		commitAll(f.work, "move away");
		const facts = await factsOf(f);
		expect(facts.spec_changes).toEqual([{ capability: "forge-read", added_requirements: [], removed_requirements: ["Read cache"], scenarios: [] }]);
		expect(facts.governance).toEqual(["specs/constraints.md"]);
		expect(facts.files).toHaveLength(2);
	});

	test("New capability", async () => {
		const f = await specRepo();
		await writeIn(f.work, "specs/retry-policy/spec.md", "# retry-policy\n\n## Requirements\n\n### Requirement: Retry\nThe system SHALL retry.\n");
		commitAll(f.work, "new cap");
		const facts = await factsOf(f);
		expect(facts.created_capabilities).toEqual(["retry-policy"]);
		expect(facts.spec_changes).toEqual([{ capability: "retry-policy", added_requirements: ["Retry"], removed_requirements: [], scenarios: [] }]);
	});

	test("Governance files", async () => {
		const f = await specRepo();
		await writeIn(f.work, "specs/constraints.md", "# constraints\n");
		await writeIn(f.work, "specs/decisions/0007-x.md", "# x\n");
		await writeIn(f.work, "specs/product.md", "# product\n");
		commitAll(f.work, "gov");
		const facts = await factsOf(f);
		expect(facts.governance.sort()).toEqual(["specs/constraints.md", "specs/decisions/0007-x.md"]);
		expect(facts.created_capabilities).toEqual([]);
		expect(facts.spec_changes).toEqual([]);
	});

	test("integration merge is not counted", async () => {
		const f = await specRepo();
		await writeIn(f.work, "src/forge/read.ts", "export const a = 2;\n");
		commitAll(f.work, "fix");
		await upstreamCommit(f, "upstream.ts");
		sh(f.work, "fetch", "-q", "origin", "main");
		sh(f.work, "merge", "-q", "--no-edit", "--no-ff", "origin/main");
		const facts = await factsOf(f);
		expect(facts.files).toEqual(["src/forge/read.ts"]);
	});

	test("Code without spec change", async () => {
		const f = await specRepo();
		await writeIn(f.work, "src/forge/read.ts", "export const a = 2;\n");
		await writeIn(f.work, "src/other.ts", "x\n");
		commitAll(f.work, "code");
		const facts = await factsOf(f);
		expect(facts.capability_code).toEqual([{ capability: "forge-read", files: ["src/forge/read.ts"], spec_changed: false }]);
		expect(facts.spec_changes).toEqual([]);
	});

	test("uncommitted spec edits do not count", async () => {
		const f = await specRepo();
		await writeIn(f.work, "src/forge/read.ts", "export const a = 2;\n");
		commitAll(f.work, "code");
		await writeIn(f.work, "specs/forge-read/spec.md", `${SPEC}\n### Requirement: Retry budget\nx\n`);
		const facts = await factsOf(f);
		expect(facts.spec_changes).toEqual([]);
		expect(facts.files).toEqual(["src/forge/read.ts"]);
	});
});
