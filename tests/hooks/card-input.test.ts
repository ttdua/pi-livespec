import { afterEach, describe, expect, test } from "vitest";
import { writeMarked } from "../../src/forge/markers.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { CHANGE_BRANCH } from "./helpers.ts";
import { cleanupDirs, type ToolHarness, toolHarness } from "../tools/helpers.ts";
import { renderCard } from "../../src/hooks/phase-card.ts";
import { requireChange } from "../../src/tools/guard.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";

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

const SPEC = "# forge-read\n\n## Purpose\nRead.\n\n## Requirements\n\n### Requirement: Read cache\nThe system SHALL cache.\n\n#### Scenario: Fresh\n- **WHEN** a\n- **THEN** b\n";

/** A harness on `fix/typo`; `commit` adds one README commit after `main`. */
async function onFix(o: { commit?: boolean; files?: Record<string, string> } = {}): Promise<ToolHarness> {
	const h = await toolHarness({ branch: "fix/typo", ...(o.files ? { files: o.files } : {}) });
	if (o.commit !== false) {
		await writeIn(h.root, "README.md", "fixed\n");
		commitAll(h.root, "Fix a typo in the README");
	}
	return h;
}

function fixInput(h: ToolHarness) {
	const c = h.session.card;
	if (c.kind !== "fix") throw new Error(`no fix card: ${c.kind}`);
	return c;
}

describe("buildCardInput on a fix branch", () => {
	test("small fix: the lane outcome of the committed diff", async () => {
		const h = await onFix();
		await h.session.refresh();
		expect(fixInput(h)).toMatchObject({ slug: "typo", outcome: { lane: "small", reasons: [] } });
	});

	test("forced fix lists the reason", async () => {
		const h = await onFix({ files: { "specs/forge-read/spec.md": SPEC } });
		await writeIn(h.root, "specs/forge-read/spec.md", `${SPEC}\n### Requirement: Retry budget\nThe system SHALL retry.\n`);
		commitAll(h.root, "Add a retry budget");
		await h.session.refresh();
		const card = fixInput(h);
		expect(card.outcome?.lane).toBe("forced");
		expect(card.outcome?.reasons.join("\n")).toContain("Retry budget");
	});

	test("no commit after the merge base is empty", async () => {
		const h = await onFix({ commit: false });
		await h.session.refresh();
		expect(fixInput(h)).toEqual(expect.objectContaining({ slug: "typo", empty: true }));
		expect(fixInput(h).outcome).toBeUndefined();
	});

	test("facts failure (no origin) becomes an error, never a throw", async () => {
		const h = await onFix();
		h.git("remote", "remove", "origin");
		await h.session.refresh();
		const card = fixInput(h);
		expect(card.error).toMatch(/origin/);
		expect(card.outcome).toBeUndefined();
		expect(renderCard(card)).not.toMatch(/subagent/);
	});

	test("refresh twice fetches once", async () => {
		const h = await onFix();
		await h.session.refresh();
		await h.session.refresh();
		expect(h.gitCalls.filter((a) => a[0] === "fetch")).toHaveLength(1);
		h.git("commit", "-q", "--allow-empty", "-m", "second");
		await h.session.refresh();
		expect(h.gitCalls.filter((a) => a[0] === "fetch")).toHaveLength(2);
	});

	test("the card records no decision", async () => {
		const h = await onFix();
		await h.session.refresh();
		expect(await h.world.forge.listPullRequests({ state: "open", head: "fix/typo" })).toHaveLength(0);
		expect(h.git("status", "--porcelain")).toBe("");
	});

	test("requireChange refuses with the fix sentence", async () => {
		const h = await onFix();
		await h.session.refresh();
		expect(requireChange(h.session)).toEqual({ ok: false, message: "On fix/typo: run fix_ship or change_new <name> --from-fix; there is no change issue." });
	});
});
