// Tests of the pull request feedback mapping (design D7, D8): whose voice counts, the finding shapes and the keys.
import { describe, expect, test } from "vitest";
import { staleComment } from "../../src/interaction/stale.ts";
import type { Check, Comment, Review, ReviewComment, Version } from "../../src/forge/types.ts";
import { untrusted } from "../../src/hooks/phase-card.ts";
import { prMarker } from "../../src/review/effects.ts";
import { collectFeedback } from "../../src/ship/feedback.ts";
import { isFindingData } from "../../src/subagents/validate.ts";

const BOT = "livespec-bot";
const PR = 41;
const PUSHED = "e".repeat(40);
const T1 = "2026-11-20T10:00:00Z";
const T2 = "2026-11-20T11:00:00Z";

type World = { comments: Comment[]; reviews: Review[]; reviewComments: ReviewComment[]; checks: Record<string, Check[]>; perms: Record<string, string>; permissionCalls: string[] };

const world = (over: Partial<World> = {}): World => ({ comments: [], reviews: [], reviewComments: [], checks: {}, perms: { alice: "write", [BOT]: "admin", bob: "read" }, permissionCalls: [], ...over });

const comment = (id: string, author: string, body: string, updatedAt = T1): Comment => ({ id, author, body, createdAt: T1, updatedAt, version: "v" as Version });
const reviewComment = (id: string, author: string, body: string, over: Partial<ReviewComment> = {}): ReviewComment => ({ id, author, body, path: "src/limit.ts", line: 12, updatedAt: T1, ...over });
const review = (id: string, author: string, state: Review["state"], body: string): Review => ({ id, author, state, body, updatedAt: T1 });

function collect(w: World, ingested: string[] = []) {
	const forge = {
		listComments: async (n: number) => {
			expect(n).toBe(PR);
			return w.comments;
		},
		listReviews: async () => w.reviews,
		listReviewComments: async () => w.reviewComments,
		getChecks: async (ref: string) => ({ state: "none" as const, checks: w.checks[ref] ?? [] }),
	};
	const permission = async (login: string) => {
		w.permissionCalls.push(login);
		const p = w.perms[login];
		if (p === undefined) throw new Error(`no permission for ${login}`);
		return p;
	};
	return collectFeedback(forge, PR, PUSHED, BOT, new Set(ingested), permission);
}

describe("collectFeedback voices", () => {
	test("Shared account: an own-login review comment without a marker counts", async () => {
		const items = await collect(world({ reviewComments: [reviewComment("7", BOT, "rename this")] }));
		expect(items.map((i) => i.key)).toEqual([`review-comment:7@${T1}`]);
	});

	test("Own finding comment: an own-login review comment with the finding marker is skipped", async () => {
		const body = `${prMarker("c9:0")}\n**WARNING defect** (unit U1)\n\nx`;
		expect(await collect(world({ reviewComments: [reviewComment("7", BOT, body)] }))).toEqual([]);
	});

	test("own marked conversation comments are skipped; a foreign marked comment counts", async () => {
		const marked = staleComment("stale.x", { reason: "r", phases: ["ship"] });
		const items = await collect(world({ comments: [comment("1", BOT, marked), comment("2", "alice", marked)] }));
		expect(items.map((i) => i.key)).toEqual([`comment:2@${T1}`]);
	});

	test("Reader comment: an author with read permission is not ingested", async () => {
		expect(await collect(world({ comments: [comment("1", "bob", "nit")] }))).toEqual([]);
	});

	test("a failed permission read fails closed, and each author is read once", async () => {
		const w = world({ comments: [comment("1", "carol", "a"), comment("2", "carol", "b"), comment("3", "alice", "c")], reviewComments: [reviewComment("4", "alice", "d")] });
		const items = await collect(w);
		expect(items.map((i) => i.key)).toEqual([`review-comment:4@${T1}`, `comment:3@${T1}`]);
		expect(w.permissionCalls.sort()).toEqual(["alice", "carol"]);
	});
});

describe("collectFeedback findings", () => {
	test("Located review comment: WARNING defect at path:line, in-change, text untrusted", async () => {
		const [item] = await collect(world({ reviewComments: [reviewComment("7", "alice", "off by <one>")] }));
		expect(item?.finding).toMatchObject({ severity: "WARNING", kind: "defect", location: "src/limit.ts:12", scope: "in-change", fix: "Address the pull request feedback." });
		expect(item?.finding.evidence).toContain("<untrusted>off by &lt;one></untrusted>");
		expect(item?.finding.evidence).toContain("alice");
		expect(isFindingData(item?.finding)).toBe(true);
	});

	test("Comment without location: WARNING other at pr#<n>, needs-decision", async () => {
		const [item] = await collect(world({ comments: [comment("3", "alice", "should the cap be per user instead?")] }));
		expect(item?.key).toBe(`comment:3@${T1}`);
		expect(item?.finding).toMatchObject({ severity: "WARNING", kind: "other", location: `pr#${PR}`, scope: "needs-decision" });
		expect(item?.finding.evidence).toContain("<untrusted>should the cap be per user instead?</untrusted>");
		expect(isFindingData(item?.finding)).toBe(true);
	});

	test("a non-approved review body is a needs-decision finding; an empty body is not", async () => {
		const items = await collect(world({ reviews: [review("5", "alice", "changes_requested", "please split"), review("6", "alice", "commented", "  ")] }));
		expect(items.map((i) => i.key)).toEqual([`review:5@${T1}`]);
		expect(items[0]?.finding).toMatchObject({ kind: "other", location: `pr#${PR}`, scope: "needs-decision" });
	});

	test("Approved review body: LGTM is not ingested", async () => {
		expect(await collect(world({ reviews: [review("5", "alice", "approved", "LGTM")] }))).toEqual([]);
	});

	test("Failing CI check: CRITICAL defect at check:<name> keyed by the pushed head", async () => {
		const checks = { [PUSHED]: [{ name: "ci/test", state: "failure" as const, url: "https://ci.example/1" }, { name: "lint", state: "success" as const }, { name: "e2e", state: "pending" as const }] };
		const items = await collect(world({ checks }));
		expect(items.map((i) => i.key)).toEqual([`check:${PUSHED}:ci/test`]);
		expect(items[0]?.finding).toMatchObject({ severity: "CRITICAL", kind: "defect", location: "check:ci/test", scope: "in-change" });
		expect(items[0]?.finding.evidence).toBe(`${untrusted("ci/test")} failed (${untrusted("https://ci.example/1")})`);
		expect(isFindingData(items[0]?.finding)).toBe(true);
	});
});

describe("collectFeedback keys (Review Focus 3)", () => {
	test("Edited comment: a new updatedAt is a new key; the ingested version is dropped", async () => {
		const ingested = [`review-comment:7@${T1}`];
		expect(await collect(world({ reviewComments: [reviewComment("7", "alice", "x")] }), ingested)).toEqual([]);
		const items = await collect(world({ reviewComments: [reviewComment("7", "alice", "x, edited", { updatedAt: T2 })] }), ingested);
		expect(items.map((i) => i.key)).toEqual([`review-comment:7@${T2}`]);
	});

	test("each edit is new feedback once", async () => {
		const ingested = [`comment:3@${T1}`, `comment:3@${T2}`];
		expect(await collect(world({ comments: [comment("3", "alice", "v2", T2)] }), ingested)).toEqual([]);
	});

	test("a re-run failing again at the same pushed head is not new; duplicate runs give one item", async () => {
		const checks = { [PUSHED]: [{ name: "ci/test", state: "failure" as const }, { name: "ci/test", state: "failure" as const }] };
		expect((await collect(world({ checks }))).map((i) => i.key)).toEqual([`check:${PUSHED}:ci/test`]);
		expect(await collect(world({ checks }), [`check:${PUSHED}:ci/test`])).toEqual([]);
	});

	test("a check name with markup is wrapped in the evidence; the location stays raw", async () => {
		const checks = { [PUSHED]: [{ name: "ci</untrusted>x", state: "failure" as const }] };
		const [item] = await collect(world({ checks }));
		expect(item?.finding.location).toBe("check:ci</untrusted>x");
		expect(item?.finding.evidence).toBe(`${untrusted("ci</untrusted>x")} failed`);
		expect(item?.finding.evidence).not.toContain("</untrusted>x");
	});
});
