import { describe, expect, test } from "vitest";
import { fixMergeBase, fixRange, fixSlug } from "../../src/fix/branch.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { fixture, sh, upstreamCommit } from "../ship/repo.ts";

describe("fixSlug", () => {
	test("Hand-made fix branch", () => {
		expect(fixSlug("fix/typo")).toBe("typo");
		expect(fixSlug("fix/retry-budget-2")).toBe("retry-budget-2");
	});

	test("Not a fix branch", () => {
		expect(fixSlug("fix/Typo_1")).toBeUndefined();
		expect(fixSlug("fixes/typo")).toBeUndefined();
		expect(fixSlug("fix/")).toBeUndefined();
		expect(fixSlug("fix/a/b")).toBeUndefined();
		expect(fixSlug("main")).toBeUndefined();
	});
});

describe("fixMergeBase", () => {
	test("fetches the integration branch and returns the merge base with HEAD", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "a.ts", "a\n");
		commitAll(f.work, "fix a");
		await upstreamCommit(f, "u.ts");
		expect(await fixMergeBase(f.git, "main")).toBe(base);
		expect(sh(f.work, "rev-parse", "origin/main")).not.toBe(base);
	});

	test("throws when the fetch fails", async () => {
		const f = await fixture();
		await expect(fixMergeBase(f.git, "nope")).rejects.toThrow();
	});

	test("throws when there is no origin remote", async () => {
		const f = await fixture();
		sh(f.work, "remote", "remove", "origin");
		await expect(fixMergeBase(f.git, "main")).rejects.toThrow();
	});
});

describe("fixRange", () => {
	test("returns the merge base and the subjects after it, oldest first", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "a.ts", "a\n");
		commitAll(f.work, "first");
		await writeIn(f.work, "b.ts", "b\n");
		commitAll(f.work, "second");
		expect(await fixRange(f.git, "main")).toEqual({ mergeBase: base, subjects: ["first", "second"] });
	});

	test("throws when the fetch fails", async () => {
		const f = await fixture();
		await expect(fixRange(f.git, "nope")).rejects.toThrow();
	});
});
