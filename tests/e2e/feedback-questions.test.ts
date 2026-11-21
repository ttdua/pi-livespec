// A pull request feedback round keeps every human item as its own finding and raises one question per item
// (finding-routing "Aggregate findings"; ship-phase feedback).

import { afterEach, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { aggregates, latestRun } from "../../src/review/records.ts";
import type { AggregateFinding } from "../../src/subagents/records.ts";
import { pollFeedback } from "../../src/ship/feedback-poll.ts";
import { registerSpecReview } from "../../src/tools/spec-review.ts";
import { cleanupDirs, textOf, type ToolHarness } from "../tools/helpers.ts";
import { FORGE_CHAIN, marked, shipReady } from "../tools/ship-fixture.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

async function shippedPr(): Promise<ToolHarness & { pr: number }> {
	const h = await shipReady({ config: FORGE_CHAIN });
	expect((await h.call("change_ship")).isError).toBeFalsy();
	const card = h.session.card;
	if (card.kind !== "change" || card.state.pr === undefined) throw new Error("no shipped change");
	await h.world.setPermission("alice", "write");
	await h.world.setPermission("bob", "write");
	return { ...h, pr: card.state.pr.number };
}

async function routeRound(h: ToolHarness): Promise<void> {
	registerSpecReview(h.pi.api as never);
	for (let i = 0; i < 4 && !latestRun(await marked(h))?.routed; i++) {
		const out = await h.call("spec_review", {});
		expect(out.isError, textOf(out)).toBeFalsy();
	}
	expect(latestRun(await marked(h))?.routed).toBe(true);
}

test("two conversation comments become two needs-decision findings and two distinct questions", async () => {
	const h = await shippedPr();
	await h.world.postComment(h.pr, "alice", "should the cap be per user?");
	await h.world.postComment(h.pr, "bob", "please document the header");
	expect(await pollFeedback(h.session)).toEqual({ ingested: 2 });
	await routeRound(h);
	const aggregate = aggregates(await marked(h)).at(-1);
	const findings = (aggregate?.data.findings ?? []) as AggregateFinding[];
	expect(findings).toHaveLength(2);
	expect(findings.map((f) => [f.location.replace(/:\d+$/, ""), f.route])).toEqual([[`pr#${h.pr}`, "question"], [`pr#${h.pr}`, "question"]]);
	const questions = parseChange(await h.world.bodyOf(h.n)).questions.map((q) => q.text);
	expect(questions).toHaveLength(2);
	const id = aggregate?.commentId;
	expect(questions[0]).toContain(`finding:${id}:0`);
	expect(questions[1]).toContain(`finding:${id}:1`);
	expect(new Set(questions).size).toBe(2);
});

test("two review comments at the same path and line stay two findings", async () => {
	const h = await shippedPr();
	await h.world.seedReviewComment(h.pr, { author: "alice", path: "src/limit.ts", line: 1, body: "rename cap" });
	await h.world.seedReviewComment(h.pr, { author: "bob", path: "src/limit.ts", line: 1, body: "add a comment" });
	expect(await pollFeedback(h.session)).toEqual({ ingested: 2 });
	await routeRound(h);
	const findings = aggregates(await marked(h)).at(-1)?.data.findings ?? [];
	expect(findings).toHaveLength(2);
	expect(findings.map((f) => f.evidence).join(" ")).toContain("rename cap");
	expect(findings.map((f) => f.evidence).join(" ")).toContain("add a comment");
});
