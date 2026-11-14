import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatResults, hasErrors, runValidate, runValidateCommand } from "../../src/commands/validate.ts";
import { makeRepo, writeIn } from "../helpers/repo.ts";

const GOOD = `# rate-limit

## Purpose
Limit requests.

## Requirements

### Requirement: Limit
The system SHALL limit requests.

#### Scenario: Over limit
- **WHEN** a client exceeds the limit
- **THEN** the request is rejected
`;

const BAD = GOOD.replace(/#### Scenario[\s\S]*$/, "");

describe("validate", () => {
	it("clean repository", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/rate-limit/spec.md", GOOD);
		const results = await runValidate(root);
		expect(results).toEqual([]);
		expect(hasErrors(results)).toBe(false);
	});

	it("error present", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/rate-limit/spec.md", BAD);
		const results = await runValidate(root);
		expect(results.some((r) => r.code === "spec-scenario-missing")).toBe(true);
		expect(hasErrors(results)).toBe(true);
		expect(formatResults(results)).toContain("spec-scenario-missing");
	});

	it("missing specs folder", async () => {
		const root = await makeRepo();
		expect(await runValidate(root)).toEqual([]);
	});

	it("free text passes through", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/product.md", "anything ### Requirement: no\n");
		await writeIn(root, "specs/constraints.md", "## whatever\n");
		await writeIn(root, "specs/bare-work.md", "garbage\n");
		expect(await runValidate(root)).toEqual([]);
	});
});

const MALFORMED = "---\nkey: [unclosed\n  : : :\n---\n# broken\n";
const BAD_DECISION = "---\nstatus: superseded\n---\n# t\n";

describe("validate error boundaries", () => {
	it("malformed capability does not hide errors in other files", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/a/spec.md", BAD);
		await writeIn(root, "specs/b/spec.md", MALFORMED);
		await writeIn(root, "specs/c/spec.md", BAD);
		const results = await runValidate(root);
		const parse = results.filter((r) => r.code === "file-parse");
		expect(parse).toHaveLength(1);
		expect(parse[0]).toMatchObject({ severity: "error", file: "specs/b/spec.md" });
		expect(parse[0]!.message.length).toBeGreaterThan(0);
		const files = results.filter((r) => r.code === "spec-scenario-missing").map((r) => r.file);
		expect(files).toEqual(["specs/a/spec.md", "specs/c/spec.md"]);
		expect(hasErrors(results)).toBe(true);
	});

	it("malformed decision does not hide other decision errors", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/decisions/0001-a.md", BAD_DECISION);
		await writeIn(root, "specs/decisions/0002-b.md", MALFORMED);
		const results = await runValidate(root);
		expect(results.find((r) => r.code === "file-parse")?.file).toBe("specs/decisions/0002-b.md");
		expect(results.some((r) => r.code === "decision-superseded")).toBe(true);
	});

	it("malformed capability through the command boundary", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/a/spec.md", BAD);
		await writeIn(root, "specs/b/spec.md", MALFORMED);
		await writeIn(root, "specs/c/spec.md", BAD);
		const out = await runValidateCommand(root);
		expect(out.exitCode).toBe(1);
		expect(out.results.map((r) => r.file)).toEqual(
			expect.arrayContaining(["specs/a/spec.md", "specs/b/spec.md", "specs/c/spec.md"]),
		);
		expect(out.message).toContain("file-parse");
	});

	it("specs being a file is an error, not absent", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs", "not a directory");
		const results = await runValidate(root);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ code: "file-unreadable", severity: "error", file: "specs" });
	});

	it("non-ENOENT failure reading spec.md (ENOTDIR) is an error", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/a/spec.md/inner", "x");
		const results = await runValidate(root);
		expect(results.map((r) => r.code)).toEqual(["file-unreadable"]);
		expect(results[0]!.file).toBe("specs/a/spec.md");
	});

	it.skipIf(process.getuid?.() === 0)("unreadable decisions dir is an error", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/decisions/0001-a.md", "# x\n");
		const dir = join(root, "specs/decisions");
		await chmod(dir, 0o000);
		try {
			const results = await runValidate(root);
			expect(results.map((r) => r.code)).toContain("file-unreadable");
			expect(results.find((r) => r.code === "file-unreadable")?.file).toBe("specs/decisions");
		} finally {
			await chmod(dir, 0o755);
		}
	});

	it.skipIf(process.getuid?.() === 0)("unreadable spec.md is an error and others continue", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/a/spec.md", GOOD);
		await writeIn(root, "specs/b/spec.md", BAD);
		await chmod(join(root, "specs/a/spec.md"), 0o000);
		const results = await runValidate(root);
		expect(results.find((r) => r.code === "file-unreadable")?.file).toBe("specs/a/spec.md");
		expect(results.some((r) => r.code === "spec-scenario-missing")).toBe(true);
	});
});

describe("runValidateCommand", () => {
	it("exitCode 0 for clean repository", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/rate-limit/spec.md", GOOD);
		expect(await runValidateCommand(root)).toEqual({ message: "No validation results.", results: [], exitCode: 0 });
	});

	it("exitCode 1 iff errors", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/rate-limit/spec.md", BAD);
		const out = await runValidateCommand(root);
		expect(out.exitCode).toBe(1);
		expect(out.message).toBe(formatResults(out.results));
	});

	it("missing specs folder is exitCode 0 with a notice", async () => {
		const root = await makeRepo();
		const out = await runValidateCommand(root);
		expect(out.exitCode).toBe(0);
		expect(out.message).toMatch(/nothing to validate/i);
	});

	it("exitCode 1 when specs is unreadable", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs", "file");
		expect((await runValidateCommand(root)).exitCode).toBe(1);
	});
});

describe("validate walker", () => {
	it("handles decisions, glossary, several capabilities, CRLF and ignores non-md files", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/a/spec.md", GOOD.replace(/\n/g, "\r\n"));
		await writeIn(root, "specs/b/spec.md", GOOD);
		await writeIn(root, "specs/c/spec.md", GOOD.replace(/\n/g, "\r\n"));
		await writeIn(root, "specs/glossary.md", "# Glossary\n\n- **Term**: a definition\n");
		await writeIn(root, "specs/decisions/0001-a.md", "---\nstatus: accepted\n---\n# a\n");
		await writeIn(root, "specs/decisions/0002-b.md", "---\r\nstatus: accepted\r\n---\r\n# b\r\n");
		await writeIn(root, "specs/decisions/notes.txt", "status: superseded garbage");
		await writeIn(root, "specs/decisions/0003-bad.json", "{ not md");
		expect(await runValidate(root)).toEqual([]);
	});

	it("still reports errors across walker areas", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/a/spec.md", GOOD);
		await writeIn(root, "specs/b/spec.md", BAD);
		await writeIn(root, "specs/decisions/0001-a.md", BAD_DECISION);
		await writeIn(root, "specs/decisions/readme.txt", "ignored");
		const codes = (await runValidate(root)).map((r) => r.code);
		expect(codes).toEqual(["spec-scenario-missing", "decision-superseded"]);
	});
});
