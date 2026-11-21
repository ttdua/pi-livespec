// End-to-end ship flow (issue #32 "Done when"): ship gate, one pull request, an unreviewed commit refused, a failing
// check routed on the same pull request, a reviewed fix pushed, a human merge and the close.

import { afterEach, expect, test } from "vitest";
import { setSession } from "../../src/hooks/session-store.ts";
import { aggregates, latestRun, type ReviewRunData } from "../../src/review/records.ts";
import { registerSpecReview } from "../../src/tools/spec-review.ts";
import { pollFeedback } from "../../src/ship/feedback-poll.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, originRefs, textOf, type ToolHarness } from "../tools/helpers.ts";
import { approveShip, branchOf, gateComment, marked, ofKind, openPulls, shipReady } from "../tools/ship-fixture.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const labels = async (h: ToolHarness) => (await h.world.forge.getIssue(h.n)).labels;
const phase = async (h: ToolHarness) => (await labels(h)).find((l) => l.startsWith("livespec:phase/"));
const emits = (h: ToolHarness) => (h.pi.api.events.emit as unknown as { mock: { calls: unknown[][] } }).mock.calls;

async function commitFix(h: ToolHarness): Promise<string> {
	await writeIn(h.root, "src/limit.ts", "export const cap = 101;\n");
	commitAll(h.root, "fix");
	return h.git("rev-parse", "HEAD");
}

test("ship, failing check on the same pull request, reviewed fix push, merge and close", async () => {
	// Review gate approved at HEAD; docs table, then the ship gate.
	const h = await shipReady({ noShipGate: true });
	expect(textOf(await h.call("docs_table", { rows: [{ file: "specs/glossary.md", status: "not needed", reason: "no new term" }] }))).not.toContain("refus");
	await approveShip(h, "a1");

	// change_ship opens exactly one pull request that refers to the issue and records it.
	const shipped = await h.call("change_ship");
	expect(shipped.isError, textOf(shipped)).toBeFalsy();
	const pulls = await openPulls(h);
	expect(pulls).toHaveLength(1);
	const pr = pulls[0]?.number as number;
	expect(pulls[0]?.body).toContain(`Refs #${h.n}`);
	expect(await h.world.bodyOf(h.n)).toContain(`PR: #${pr}`);
	const pushedHead = h.git("rev-parse", "HEAD");

	// A failing CI check on the pushed head is ingested by the poll as a pull-request round; the change returns to review.
	await h.world.seedStatus(pushedHead, { name: "ci/test", state: "failure", url: "https://ci.example/1" });
	expect(await pollFeedback(h.session)).toEqual({ ingested: 1 });
	expect(await phase(h)).toBe("livespec:phase/review");
	const run = (await ofKind(h, "review-run"))[0]?.data as ReviewRunData;
	expect(run.source).toBe("pull-request");
	expect(run.parentFindings).toEqual([expect.objectContaining({ location: "check:ci/test", scope: "in-change" })]);

	// spec_review routes the feedback round itself: no reviewer or executor, the parent finding is verified as skipped.
	registerSpecReview(h.pi.api as never, { home: () => h.home });
	for (let i = 0; i < 4 && !(latestRun(await marked(h))?.routed); i++) {
		const out = await h.call("spec_review", {});
		expect(out.isError, textOf(out)).toBeFalsy();
	}
	const own = await marked(h);
	expect(latestRun(own)).toMatchObject({ round: run.round, routed: true, source: "pull-request" });
	expect(aggregates(own).at(-1)?.data.findings).toEqual([expect.objectContaining({ location: "check:ci/test", route: "in-change", verify: "skipped-parent" })]);
	expect(await h.world.forge.listReviewComments(pr)).toEqual([]);
	const card = h.session.card;
	if (card.kind !== "change") throw new Error("no change card");
	expect(card.step.next).toContain("unit_amend --add");
	expect(card.step.next).toContain("ci/test");

	// A new non-merge commit is unreviewed: both tools refuse.
	const unreviewed = await commitFix(h);
	await h.session.refresh();
	const refusedShip = await h.call("change_ship");
	expect(refusedShip.isError).toBe(true);
	const refusedPush = await h.call("change_push");
	expect(refusedPush.isError).toBe(true);
	expect(textOf(refusedPush)).toContain("Nothing was pushed");
	expect(await openPulls(h)).toHaveLength(1);

	// The fix is reviewed at the new HEAD; change_push updates the same branch, no second pull request.
	await h.world.postComment(h.n, BOT_LOGIN, gateComment("review", `self-${unreviewed.slice(0, 7)}`, unreviewed));
	await h.world.forge.removeLabels(h.n, ["livespec:phase/review"]);
	await h.world.forge.addLabels(h.n, ["livespec:phase/ship"]);
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
	const pushed = await h.call("change_push");
	expect(pushed.isError, textOf(pushed)).toBeFalsy();
	expect(originRefs(h.origin)).toContain(`${unreviewed} refs/heads/${branchOf(h)}`);
	expect(await openPulls(h)).toHaveLength(1);

	// The issue stays open until a human merges; the merge moves the change to close and change_close closes it.
	expect((await h.world.forge.getIssue(h.n)).state).toBe("open");
	await h.world.closePullRequestBehindBack(pr, true);
	await h.session.refresh();
	expect(await phase(h)).toBe("livespec:phase/close");
	expect((await h.world.forge.getIssue(h.n)).state).toBe("open");
	const closed = await h.call("change_close", {});
	expect(closed.isError, textOf(closed)).toBeFalsy();
	expect((await h.world.forge.getIssue(h.n)).state).toBe("closed");
	expect(emits(h).filter((c) => c[0] === "livespec:change-closed")).toEqual([["livespec:change-closed", { change: h.n, pr }]]);
});
