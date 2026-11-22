import { describe, expect, test } from "vitest";
import { fixEmptyReason, fixMergeBase, fixRange, fixSlug } from "../../src/fix/branch.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { fixture, sh, upstreamCommit, type Fixture } from "../ship/repo.ts";

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
		expect(await fixRange(f.git, "main")).toEqual({ mergeBase: base, subjects: ["first", "second"], empty: false });
	});

	test("throws when the fetch fails", async () => {
		const f = await fixture();
		await expect(fixRange(f.git, "nope")).rejects.toThrow();
	});
});

describe("fixRange empty", () => {
	const commitFix = async (f: Fixture, rel: string, text: string, msg: string): Promise<void> => {
		await writeIn(f.work, rel, text);
		commitAll(f.work, msg);
	};
	const squashed = async (f: Fixture): Promise<void> => {
		await commitFix(f, "a.ts", "a\n", "fix a");
		await upstreamCommit(f, "a.ts", "a\n");
	};

	test("no commit is empty", async () => {
		const f = await fixture();
		expect((await fixRange(f.git, "main")).empty).toBe(true);
	});

	test("real fix is not empty", async () => {
		const f = await fixture();
		await commitFix(f, "a.ts", "a\n", "fix a");
		const r = await fixRange(f.git, "main");
		expect(r.empty).toBe(false);
		expect(r.subjects).toEqual(["fix a"]);
	});

	test("Squash-merged fix is empty", async () => {
		const f = await fixture();
		await squashed(f);
		await upstreamCommit(f, "later.ts");
		const r = await fixRange(f.git, "main");
		expect(r.subjects).toHaveLength(1);
		expect(r.empty).toBe(true);
	});

	test("Rebase-merged fix is empty", async () => {
		const f = await fixture();
		await commitFix(f, "a.ts", "a\n", "fix a");
		await commitFix(f, "b.ts", "b\n", "fix b");
		await upstreamCommit(f, "a.ts", "a\n");
		await upstreamCommit(f, "b.ts", "b\n");
		const r = await fixRange(f.git, "main");
		expect(r.subjects).toHaveLength(2);
		expect(r.empty).toBe(true);
	});

	test("Conflicting fix is not empty", async () => {
		const f = await fixture();
		await commitFix(f, "README.md", "mine\n", "mine");
		await upstreamCommit(f, "README.md", "theirs\n");
		expect((await fixRange(f.git, "main")).empty).toBe(false);
	});

	test("unsupported merge-tree falls back to tree equality", async () => {
		const f = await fixture();
		const git = { ...f.git, mergeTree: async () => "unsupported" as const };
		await squashed(f);
		expect((await fixRange(git, "main")).empty).toBe(true);
		await upstreamCommit(f, "later.ts");
		expect((await fixRange(git, "main")).empty).toBe(false);
	});

	test("missing tip or merge-tree failure is not empty", async () => {
		const f = await fixture();
		await commitFix(f, "a.ts", "a\n", "fix a");
		expect((await fixRange({ ...f.git, remoteRef: async () => undefined }, "main")).empty).toBe(false);
		const boom = {
			...f.git,
			mergeTree: async (): Promise<never> => {
				throw new Error("boom");
			},
		};
		expect((await fixRange(boom, "main")).empty).toBe(false);
	});
});

describe("fixEmptyReason", () => {
	test("names the branch and the integration branch", () => {
		expect(fixEmptyReason("fix/typo", "main")).toBe(
			"fix/typo adds nothing to origin/main (no commit after the merge base, or its changes are already there)",
		);
	});
});
