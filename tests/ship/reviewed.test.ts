import { describe, expect, test } from "vitest";
import { createGit } from "../../src/engine/git.ts";
import { isReviewed, reviewedHead } from "../../src/ship/reviewed.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { stateFor } from "../helpers/change-state.ts";
import { fixture, type Fixture, sh, upstreamCommit } from "./repo.ts";

async function reviewedAt(f: Fixture): Promise<string> {
	await writeIn(f.work, "src/a.ts", "a\n");
	commitAll(f.work, "c3");
	return sh(f.work, "rev-parse", "HEAD");
}

async function tip(f: Fixture): Promise<string> {
	sh(f.work, "fetch", "-q", "origin", "main");
	return sh(f.work, "rev-parse", "origin/main");
}

const head = (f: Fixture) => sh(f.work, "rev-parse", "HEAD");

describe("reviewedHead", () => {
	test("is the headSha of the valid approved review gate", () => {
		const gate = { outcome: "approved" as const, superseded: false, at: "", waivers: [], notes: "", headSha: "c3", commentId: "1" };
		expect(reviewedHead(stateFor("review", { lock: { locked: undefined, frozen: [], staleUnits: [], gates: { review: gate } } }))).toBe("c3");
		expect(reviewedHead(stateFor("review", { lock: { locked: undefined, frozen: [], staleUnits: [], gates: { review: { ...gate, outcome: "changes_requested" } } } }))).toBeUndefined();
		expect(reviewedHead(stateFor("review"))).toBeUndefined();
	});
});

describe("isReviewed", () => {
	test("Equal to the reviewed SHA", async () => {
		const f = await fixture();
		const c3 = await reviewedAt(f);
		expect(await isReviewed(f.git, c3, c3, await tip(f))).toEqual({ ok: true });
	});

	test("Commit after review: the reason names d4 and c3", async () => {
		const f = await fixture();
		const c3 = await reviewedAt(f);
		await writeIn(f.work, "src/b.ts", "b\n");
		commitAll(f.work, "d4");
		const d4 = await head(f);
		const r = await isReviewed(f.git, c3, d4, await tip(f));
		expect(r.ok).toBe(false);
		expect(!r.ok && r.reason).toContain(d4.slice(0, 7));
		expect(!r.ok && r.reason).toContain(c3.slice(0, 7));
	});

	test("Clean integration merge, while origin/main has its own new commit", async () => {
		const f = await fixture();
		const c3 = await reviewedAt(f);
		await upstreamCommit(f, "src/other.ts");
		await upstreamCommit(f, "src/other2.ts");
		const t = await tip(f);
		sh(f.work, "merge", "-q", "--no-edit", "--no-ff", "origin/main");
		expect(await isReviewed(f.git, c3, await head(f), t)).toEqual({ ok: true });
		await upstreamCommit(f, "src/later.ts");
		expect(await isReviewed(f.git, c3, await head(f), await tip(f))).toEqual({ ok: true });
	});

	test("Conflicted merge resolved by hand is not reviewed", async () => {
		const f = await fixture();
		await writeIn(f.work, "README.md", "mine\n");
		commitAll(f.work, "c3");
		const c3 = await head(f);
		await upstreamCommit(f, "README.md", "theirs\n");
		const t = await tip(f);
		try {
			sh(f.work, "merge", "--no-edit", "--no-ff", "origin/main");
		} catch {
			/* conflict expected */
		}
		await writeIn(f.work, "README.md", "resolved\n");
		sh(f.work, "add", "-A");
		sh(f.work, "commit", "-q", "--no-edit");
		const r = await isReviewed(f.git, c3, await head(f), t);
		expect(r.ok).toBe(false);
	});

	test("A clean merge amended by hand is not reviewed", async () => {
		const f = await fixture();
		const c3 = await reviewedAt(f);
		await upstreamCommit(f, "src/other.ts");
		const t = await tip(f);
		sh(f.work, "merge", "-q", "--no-edit", "--no-ff", "origin/main");
		await writeIn(f.work, "src/sneaky.ts", "s\n");
		sh(f.work, "add", "-A");
		sh(f.work, "commit", "-q", "--amend", "--no-edit");
		const r = await isReviewed(f.git, c3, await head(f), t);
		expect(!r.ok && r.reason).toContain("edited");
	});

	test("A second parent that is not on the integration branch is not reviewed", async () => {
		const f = await fixture();
		const c3 = await reviewedAt(f);
		sh(f.work, "checkout", "-q", "-b", "side", "main");
		await writeIn(f.work, "side.ts", "s\n");
		commitAll(f.work, "side");
		sh(f.work, "checkout", "-q", "feature");
		sh(f.work, "merge", "-q", "--no-edit", "--no-ff", "side");
		const r = await isReviewed(f.git, c3, await head(f), await tip(f));
		expect(!r.ok && r.reason).toContain("not on the integration branch");
	});

	test("unsupported merge-tree: only equality counts and the reason says git is too old", async () => {
		const f = await fixture();
		const c3 = await reviewedAt(f);
		await upstreamCommit(f, "src/other.ts");
		const t = await tip(f);
		sh(f.work, "merge", "-q", "--no-edit", "--no-ff", "origin/main");
		const git = { ...createGit(f.work), mergeTree: async () => "unsupported" as const };
		const r = await isReviewed(git, c3, await head(f), t);
		expect(!r.ok && r.reason).toContain("too old");
		expect(await isReviewed(git, c3, c3, t)).toEqual({ ok: true });
	});

	test("no reviewed SHA names the review gate", async () => {
		const f = await fixture();
		const r = await isReviewed(f.git, undefined, await head(f), await tip(f));
		expect(!r.ok && r.reason).toContain("review gate");
	});
});

describe("isReviewed after a reset", () => {
	test("HEAD reset to an ancestor of the reviewed SHA is not reviewed", async () => {
		const f = await fixture();
		const earlier = await head(f);
		const c3 = await reviewedAt(f);
		sh(f.work, "reset", "-q", "--hard", earlier);
		const r = await isReviewed(f.git, c3, await head(f), await tip(f));
		expect(r.ok).toBe(false);
	});
});
