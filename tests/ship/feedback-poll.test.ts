// Tests of the pull request feedback poll (design D8): preconditions, the feedback round's writes, dedup and single-flight.
import { afterEach, describe, expect, test } from "vitest";
import type { Forge } from "../../src/forge/types.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { aggregateComment, type ReviewRunData, reviewRunComment } from "../../src/review/records.ts";
import { reviewRounds } from "../../src/review/status.ts";
import { pollFeedback } from "../../src/ship/feedback-poll.ts";
import type { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { appendSeed } from "../helpers/ledger.ts";
import { writeIn } from "../helpers/repo.ts";
import { agg } from "../review/review-fixtures.ts";
import { cleanupDirs, textOf, type ToolHarness } from "../tools/helpers.ts";
import { gateComment, marked, type Opts, shipReady } from "../tools/ship-fixture.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

async function shipped(o: Opts = {}): Promise<ToolHarness & { pr: number; pushedHead: string }> {
	const h = await shipReady(o);
	const out = await h.call("change_ship");
	expect(out.isError, textOf(out)).toBeFalsy();
	const card = h.session.card;
	if (card.kind !== "change" || card.state.pr?.pushedHead === undefined) throw new Error("no shipped change");
	await h.world.setPermission("alice", "write");
	return { ...h, pr: card.state.pr.number, pushedHead: card.state.pr.pushedHead };
}

const runs = async (h: ToolHarness) => (await marked(h)).filter((m) => m.kind === "review-run");
const labels = async (h: ToolHarness) => (await h.world.forge.getIssue(h.n)).labels;

describe("pollFeedback preconditions", () => {
	test("Not in ship: a human comment in build is not ingested", async () => {
		const h = await shipped();
		await h.world.forge.addLabels(h.n, ["livespec:phase/build"]);
		await h.world.forge.removeLabels(h.n, ["livespec:phase/ship"]);
		await h.world.postComment(h.pr, "alice", "please rename");
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		expect(await pollFeedback(h.session)).toEqual({ skipped: true });
		expect(await runs(h)).toEqual([]);
	});

	test("a dirty tree skips", async () => {
		const h = await shipped();
		await h.world.postComment(h.pr, "alice", "please rename");
		await writeIn(h.root, "scratch.txt", "x\n");
		await h.session.refresh();
		expect(await pollFeedback(h.session)).toEqual({ skipped: true });
		expect(await runs(h)).toEqual([]);
	});

	test("an unrouted round skips", async () => {
		const h = await shipped();
		const head = h.git("rev-parse", "HEAD");
		await h.world.postComment(h.n, BOT_LOGIN, reviewRunComment({ round: 1, head, selected: ["change"], tags: [], verify: {}, parentFindings: [], routed: false }));
		await h.world.postComment(h.pr, "alice", "please rename");
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		expect(await pollFeedback(h.session)).toEqual({ skipped: true });
		expect(await runs(h)).toHaveLength(1);
	});

	test("a closed pull request skips", async () => {
		const h = await shipped();
		await h.world.postComment(h.pr, "alice", "late");
		await h.world.closePullRequestBehindBack(h.pr);
		await h.session.refresh();
		expect(await pollFeedback(h.session)).toEqual({ skipped: true });
	});

	test("a failed read is recorded and returned, never thrown", async () => {
		let failing = false;
		const forge = (world: MemoryWorld): Forge =>
			new Proxy(world.forge, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (prop !== "listReviewComments" || typeof value !== "function") return value;
					return (...args: unknown[]) => (failing ? Promise.reject(new Error("review comments unavailable")) : value.apply(target, args));
				},
			});
		const h = await shipped({ forge });
		failing = true;
		const result = await pollFeedback(h.session);
		expect(result).toEqual({ failed: expect.stringContaining("review comments unavailable") });
		expect(h.session.errors.join("\n")).toContain("review comments unavailable");
	});
});

describe("pollFeedback rounds", () => {
	test("Back to review: review-run, stale for review and ship, then the label moves", async () => {
		const h = await shipped();
		await h.world.seedStatus(h.pushedHead, { name: "ci/test", state: "failure", url: "https://ci.example/9" });
		expect(await pollFeedback(h.session)).toEqual({ ingested: 1 });
		const own = await marked(h);
		const run = own.findIndex((m) => m.kind === "review-run");
		const stale = own.findIndex((m) => m.kind === "stale" && m.id === "stale.feedback.1");
		expect(run).toBeGreaterThan(-1);
		expect(stale).toBeGreaterThan(run);
		const data = own[run]?.data as ReviewRunData;
		expect(data).toMatchObject({ round: 1, head: h.git("rev-parse", "HEAD"), source: "pull-request", selected: [], tags: [], verify: {}, routed: false, feedbackKeys: [`check:${h.pushedHead}:ci/test`] });
		expect(data.parentFindings).toEqual([expect.objectContaining({ severity: "CRITICAL", location: "check:ci/test", scope: "in-change" })]);
		expect(own[stale]?.data).toMatchObject({ phases: ["review", "ship"] });
		expect(await labels(h)).toContain("livespec:phase/review");
		expect(await labels(h)).not.toContain("livespec:phase/ship");
		const card = h.session.card;
		if (card.kind !== "change") throw new Error("no change card");
		expect(card.step.next).toContain("spec_review");
	});

	test("Polled twice: exactly one feedback round", async () => {
		const h = await shipped();
		await h.world.postComment(h.pr, "alice", "should the cap be per user instead?");
		expect(await pollFeedback(h.session)).toEqual({ ingested: 1 });
		// Route the round and pass the review gate again, as after a fix: the same comment must not come back.
		const first = (await runs(h))[0]?.data as ReviewRunData;
		await appendSeed(h, aggregateComment({ round: 1, head: first.head, reviews: [], findings: [] }));
		await h.world.postComment(h.n, BOT_LOGIN, reviewRunComment({ ...first, routed: true }));
		await h.world.postComment(h.n, BOT_LOGIN, gateComment("review", "self-2", first.head));
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		expect(await pollFeedback(h.session)).toEqual({ ingested: 0 });
		expect(new Set((await runs(h)).map((m) => m.id))).toEqual(new Set(["review-run.1"]));
	});

	test("nothing new posts nothing", async () => {
		const h = await shipped();
		const before = (await marked(h)).length;
		expect(await pollFeedback(h.session)).toEqual({ ingested: 0 });
		expect((await marked(h)).length).toBe(before);
		expect(await labels(h)).toContain("livespec:phase/ship");
	});

	test("concurrent polls share one run: one round", async () => {
		const h = await shipped();
		await h.world.postComment(h.pr, "alice", "nit");
		const [a, b] = await Promise.all([pollFeedback(h.session), pollFeedback(h.session)]);
		expect(a).toEqual({ ingested: 1 });
		expect(b).toEqual(a);
		expect(await runs(h)).toHaveLength(1);
	});

	test("an interrupted feedback round is finished: stale comment and move, no second round", async () => {
		const h = await shipped();
		const head = h.git("rev-parse", "HEAD");
		const fb = { round: 1, head, selected: [], tags: [], verify: {}, parentFindings: [], routed: false, source: "pull-request" as const, feedbackKeys: ["comment:9@t"] };
		await h.world.postComment(h.n, BOT_LOGIN, reviewRunComment(fb));
		await h.world.postComment(h.pr, "alice", "another");
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		expect(await pollFeedback(h.session)).toEqual({ ingested: 0 });
		expect((await marked(h)).filter((m) => m.kind === "stale" && m.id === "stale.feedback.1")).toHaveLength(1);
		expect(await runs(h)).toHaveLength(1);
		expect(await labels(h)).toContain("livespec:phase/review");
	});

	test("a refused move fails the poll and is recorded", async () => {
		const h = await shipped();
		await h.world.postComment(h.pr, "alice", "please rename");
		// A second phase label behind the session's back: the move to review is refused.
		await h.world.forge.addLabels(h.n, ["livespec:phase/build"]);
		const result = await pollFeedback(h.session);
		expect(result).toEqual({ failed: expect.stringContaining("cannot move to review") });
		expect(h.session.errors.join("\n")).toContain("cannot move to review");
	});

	test("a refused move in the interrupted-round recovery fails the poll", async () => {
		const h = await shipped();
		const head = h.git("rev-parse", "HEAD");
		const fb = { round: 1, head, selected: [], tags: [], verify: {}, parentFindings: [], routed: false, source: "pull-request" as const, feedbackKeys: ["comment:9@t"] };
		await h.world.postComment(h.n, BOT_LOGIN, reviewRunComment(fb));
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		await h.world.forge.addLabels(h.n, ["livespec:phase/build"]);
		expect(await pollFeedback(h.session)).toEqual({ failed: expect.stringContaining("cannot move to review") });
	});

	test("Counts toward the cap: the round is posted and counts as the third", async () => {
		const h = await shipped({ files: { ".pi/livespec/flow.yaml": "extends: agent-skills\nloops: { review_rounds: 3 }\n" } });
		const head = h.git("rev-parse", "HEAD");
		for (const round of [1, 2]) {
			const run = { round, head, selected: ["change" as const], tags: [], verify: {}, parentFindings: [], routed: true };
			await h.world.postComment(h.n, BOT_LOGIN, reviewRunComment(run));
			await appendSeed(h, aggregateComment({ round, head, reviews: [], findings: [] }));
		}
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		await h.world.seedStatus(h.pushedHead, { name: "ci/test", state: "failure" });
		expect(await pollFeedback(h.session)).toEqual({ ingested: 1 });
		const fb = (await runs(h)).find((m) => m.id === "review-run.3")?.data as ReviewRunData;
		expect(fb.source).toBe("pull-request");
		// spec_review aggregates and routes it: one blocking in-change finding.
		const finding = agg({ ...fb.parentFindings[0], route: "in-change", routeUnit: undefined, verify: "skipped-parent", from: ["parent:0"] });
		await appendSeed(h, aggregateComment({ round: 3, head: fb.head, reviews: [], findings: [finding] }));
		await h.world.postComment(h.n, BOT_LOGIN, reviewRunComment({ ...fb, routed: true }));
		expect(reviewRounds(await marked(h), 3)).toEqual({ value: 3, blocking: true });
	});
});
