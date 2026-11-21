import { describe, expect, test } from "vitest";
import type { Unit } from "../../src/core/change.ts";
import { changeDiff, filesOutsideUnits } from "../../src/ship/diff.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { fixture, sh, upstreamCommit } from "./repo.ts";

describe("changeDiff", () => {
	test("Integration merge excluded: work merged from origin/main is not in the diff", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "src/a.ts", "a\n");
		commitAll(f.work, "a");
		await upstreamCommit(f, "src/other.ts");
		sh(f.work, "fetch", "-q", "origin", "main");
		sh(f.work, "merge", "-q", "--no-edit", "--no-ff", "origin/main");
		const diff = await changeDiff(f.git, base, "main");
		expect(diff).toMatchObject({ files: ["src/a.ts"] });
	});

	test("Fetch fails: the diff starts at Base", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "src/a.ts", "a\n");
		commitAll(f.work, "a");
		const diff = await changeDiff(f.git, base, "nope");
		expect(diff).toMatchObject({ from: base, files: ["src/a.ts"] });
	});

	test("neither a fetch nor a Base is refused", async () => {
		const f = await fixture();
		expect(await changeDiff(f.git, undefined, "nope")).toHaveProperty("refused");
	});

	test("a rename lists both paths", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		sh(f.work, "mv", "README.md", "DOCS.md");
		commitAll(f.work, "rename");
		const diff = await changeDiff(f.git, base, "main");
		expect("files" in diff && [...diff.files].sort()).toEqual(["DOCS.md", "README.md"]);
	});
});

const unit = (files: string[]): Unit => ({ id: "U1", title: "t", covers: [], files, doneMeans: [], scenarios: [], depends: [], done: false, statusLine: -1, statusText: "", startLine: 0, endLine: 0, raw: {} });

describe("filesOutsideUnits", () => {
	test("keeps files no unit lists and ignores specs/", () => {
		expect(filesOutsideUnits(["src/extra.ts", "specs/a/spec.md", "src/a.ts"], [unit(["src/a.ts"])])).toEqual(["src/extra.ts"]);
	});
	test("a glob matches", () => {
		expect(filesOutsideUnits(["src/limit/x/y.ts"], [unit(["src/limit/**"])])).toEqual([]);
	});
});
