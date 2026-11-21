import { afterEach, describe, expect, test } from "vitest";
import { writeMarked } from "../../src/forge/markers.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { CHANGE_BRANCH } from "./helpers.ts";
import { cleanupDirs, type ToolHarness, toolHarness } from "../tools/helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const BODY = "Capabilities: new [], modified []\n\n## Proposal\nP.\n\n## Durable docs\n";

function approvedGate(phase: string, headSha: string): string {
	return writeMarked("gate", `${phase}.r1`, { phase, outcome: "approved", notes: "", by: "alice", at: "2026-11-15T10:00:00.000Z", adapter: "in-session", head_sha: headSha, waivers: [] });
}

/** A change in `phase` with an open pull request and the review gate approved at HEAD, seeded before the first refresh. */
async function changeIn(phase: string): Promise<ToolHarness> {
	const h = await toolHarness({ branch: CHANGE_BRANCH });
	const pr = await h.world.seedPullRequest({ head: CHANGE_BRANCH });
	const body = `Base: ${h.head}\nBranch: ${CHANGE_BRANCH}\nPR: #${pr}\n${BODY}`;
	const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", `livespec:phase/${phase}`] });
	await h.world.postComment(n, BOT_LOGIN, approvedGate("review", h.head));
	await h.session.refresh();
	return h;
}

function cardState(h: ToolHarness) {
	const c = h.session.card;
	if (c.kind !== "change") throw new Error(`no change card: ${c.kind}`);
	return c.state;
}

describe("buildCardInput ship facts", () => {
	test("in ship it fills reviewed, needsShipGate and gatesAtHead", async () => {
		const h = await changeIn("ship");
		expect(cardState(h).ship).toMatchObject({ reviewed: true, needsShipGate: expect.any(Boolean), gatesAtHead: { review: true, ship: true } });
	});

	test("in review it fills gatesAtHead only", async () => {
		const h = await changeIn("review");
		h.git("commit", "-q", "--allow-empty", "-m", "fix");
		await h.session.refresh();
		const ship = cardState(h).ship;
		expect(ship?.gatesAtHead).toEqual({ review: false, ship: true });
		expect(ship).not.toHaveProperty("reviewed");
		expect(ship).not.toHaveProperty("needsShipGate");
	});
});
