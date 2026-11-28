import { appendSeed } from "../helpers/ledger.ts";
// The application-boundary `ask` of the decision seam: a rule that asks reaches
// the human through the configured approver chain, and the answer (in session
// at once, or a forge command later) completes a `source: human` decision record.

import { pickByLabel } from "../helpers/menu.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { setHeaderLine } from "../../src/core/sections.ts";
import { registerBuiltinRules, registerRule, resetRulesForTests } from "../../src/decide/registry.ts";
import { tagsSchema } from "../../src/decide/rules/tags.ts";
import { decide } from "../../src/decide/seam.ts";
import { readOwnRecords } from "../../src/ledger/records.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { CHANGE_BODY_TEMPLATE } from "../../src/tools/change-new.ts";
import { createDecisionAsker, decisionRequest } from "../../src/tools/decide-ask.ts";
import { prepareWrite, requireChange } from "../../src/tools/guard.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import type { FakeUI } from "../hooks/fake-pi.ts";
import { CHANGE_BRANCH, resumeBody } from "../hooks/helpers.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "./helpers.ts";

const FORGE_CHAIN = "integrationBranch: main\ninteraction: { adapter: [forge] }\n";
const SESSION_CHAIN = "integrationBranch: main\ninteraction: { adapter: [in-session] }\n";
const OPTIONS = [
	{ id: "x", label: "Option X", description: "Do x." },
	{ id: "y", label: "Option Y", description: "Do y." },
];
const REC = { recommended: "x", rationale: "x is simplest." };
const FACTS = { files: ["src/a.ts"] };

beforeEach(() => {
	resetRulesForTests();
	registerBuiltinRules();
	registerRule("pick", { validate() {} }, () => ({ ask: { summary: "Pick one for U1", options: OPTIONS, ...REC } }));
});

afterEach(async () => {
	setSession(undefined);
	resetRulesForTests();
	registerBuiltinRules();
	await cleanupDirs();
});

type Change = ToolHarness & { n: number };

async function change(o: { config: string; ui?: FakeUI; body?: (head: string) => string; phase?: string }): Promise<Change> {
	const h = await toolHarness({ branch: CHANGE_BRANCH, config: o.config, ...(o.ui ? { ui: o.ui } : {}) });
	const body = (o.body ?? resumeBody)(h.head);
	const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", `livespec:phase/${o.phase ?? "build"}`] });
	await h.session.refresh();
	return { ...h, n };
}

/** Runs `decide("pick", …)` with the asker a tool would build; `digest` is set for unit subjects. */
async function decidePick(h: Change, o: { facts?: unknown; digest?: string; proposal?: boolean } = {}) {
	const w = await prepareWrite();
	if (!w.ok) throw new Error(w.message);
	const c = requireChange(w.session);
	if (!c.ok) throw new Error(c.message);
	return decide("pick", o.facts ?? FACTS, { config: { mode: "rule" }, subject: "U1", digest: o.digest, ask: createDecisionAsker(w, c.state, h.ctx, { proposal: o.proposal }) });
}

/** Own forge comments merged with the ledger entries. */
async function marked(h: Change): Promise<MarkedComment[]> {
	return (await readOwnRecords(h.world.forge, h.session.ledger, h.n, { login: BOT_LOGIN })).records;
}

/** Forge comments only: a decision result is never one. */
async function forgeKinds(h: Change): Promise<string[]> {
	return filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments.map((m) => m.kind);
}
const ofKind = async (h: Change, kind: string) => (await marked(h)).filter((m) => m.kind === kind);

describe("decision asker", () => {
	test("Rule asks: the human selects in session", async () => {
		const ui: FakeUI = { hasUI: true, select: async (_title, options) => pickByLabel(options, "Option Y") };
		const h = await change({ config: SESSION_CHAIN, ui });
		const r = await decidePick(h);
		expect(r).toMatchObject({ status: "decided", outcome: "y", source: "human", facts: FACTS });
		expect(h.ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining("Pick one for U1"), ["Option X — Do x. (Recommended)", "Option Y — Do y."]);
		const [record] = await ofKind(h, "decision");
		expect(record).toMatchObject({ id: "pick.U1", data: { point: "pick", subject: "U1", source: "human", outcome: "y", facts: FACTS } });
		const [answer] = await ofKind(h, "answer");
		expect((record?.data as { request: string }).request).toBe(answer?.id);
		expect(h.session.card.kind === "change" && h.session.card.state.requests).toEqual({ pending: [], applying: [] });
		expect(record?.source).toBe("ledger");
		expect(await forgeKinds(h)).not.toContain("decision");
	});

	test("forge answer to a pending decide request completes the record", async () => {
		const h = await change({ config: FORGE_CHAIN });
		await h.world.setPermission("alice", "write");
		const r = await decidePick(h);
		expect(r).toMatchObject({ status: "pending", requestId: expect.stringMatching(/^decide-pick-U1\./) });
		const [request] = await ofKind(h, "request");
		expect(request).toMatchObject({ id: (r as { requestId: string }).requestId });
		expect(request?.data).toMatchObject({ subject: "decide:pick.U1", mode: "blocking", options: OPTIONS, snapshot: { point: "pick", subject: "U1", facts: FACTS } });
		expect(await ofKind(h, "decision")).toEqual([]);

		await h.world.postComment(h.n, "alice", "/livespec choose y");
		const status = await h.call("spec_status");
		expect(status.isError, textOf(status)).toBeFalsy();
		const [record] = await ofKind(h, "decision");
		expect(record).toMatchObject({ id: "pick.U1", source: "ledger", data: { source: "human", outcome: "y", request: request?.id } });
		expect(await forgeKinds(h)).not.toContain("decision");
		const before = (await marked(h)).length;
		await h.call("spec_status");
		expect((await marked(h)).length).toBe(before);
		expect(h.session.card.kind === "change" && h.session.card.state.requests).toEqual({ pending: [], applying: [] });
	});

	test("Decide request kind", async () => {
		registerRule("difficulty", { validate() {} }, () => ({ ask: { summary: "Which difficulty for U1?", options: OPTIONS, ...REC } }));
		const h = await change({ config: FORGE_CHAIN });
		const w = await prepareWrite();
		if (!w.ok) throw new Error(w.message);
		const c = requireChange(w.session);
		if (!c.ok) throw new Error(c.message);
		await decide("difficulty", FACTS, { config: { mode: "rule" }, subject: "U1", ask: createDecisionAsker(w, c.state, h.ctx, {}) });
		const [request] = await ofKind(h, "request");
		expect(request?.data).toMatchObject({ subject: "decide:difficulty.U1", kind: "stuck" });
	});

	test("an open request for the subject is reported pending, not asked again", async () => {
		const h = await change({ config: FORGE_CHAIN });
		const first = await decidePick(h);
		const second = await decidePick(h);
		expect(second).toEqual(first);
		expect(await ofKind(h, "request")).toHaveLength(1);
	});

	test("an open forge request missing from a stale snapshot is pending, not asked in session", async () => {
		const h = await change({ config: "integrationBranch: main\ninteraction: { adapter: [in-session, forge] }\n", ui: { hasUI: true, select: async () => "Option Y [y]" } });
		const w = await prepareWrite();
		if (!w.ok) throw new Error(w.message);
		const stale = requireChange(w.session);
		if (!stale.ok) throw new Error(stale.message);
		const existing = decisionRequest(stale.state, { point: "pick", subject: "U1", facts: FACTS, summary: "Pick one for U1", options: OPTIONS, ...REC }, new Date(0));
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("request", existing.id, { ...existing.record, id: undefined }));
		const r = await decide("pick", FACTS, { config: { mode: "rule" }, subject: "U1", ask: createDecisionAsker(w, stale.state, h.ctx) });
		expect(r).toEqual({ status: "pending", requestId: existing.id });
		expect(h.ctx.ui.select).not.toHaveBeenCalled();
		expect((await marked(h)).map((m) => m.kind)).toEqual(["request"]);
	});

	test("a rule recommendation becomes a rule-authored briefing", async () => {
		await change({ config: SESSION_CHAIN });
		const w = await prepareWrite();
		if (!w.ok) throw new Error(w.message);
		const c = requireChange(w.session);
		if (!c.ok) throw new Error(c.message);
		const intent = { point: "pick", subject: "U1", facts: FACTS, summary: "Pick one", options: OPTIONS, recommended: "x", rationale: "because" };
		expect(decisionRequest(c.state, intent, new Date(0)).briefing).toEqual({ summary: "Pick one", recommended: "x", rationale: "because", author: "rule" });
	});

	test("a dismissed in-session dialog is recorded and does not decide", async () => {
		const h = await change({ config: SESSION_CHAIN, ui: { hasUI: true, select: async () => undefined } });
		await expect(decidePick(h)).rejects.toThrow(/without a choice/);
		const [record] = await ofKind(h, "decision");
		expect(record?.data).toMatchObject({ source: "human", outcome: null, reason: expect.stringContaining("dismissed") });
	});

	test("no available adapter refuses and writes nothing", async () => {
		const h = await change({ config: SESSION_CHAIN });
		await expect(decidePick(h)).rejects.toThrow(/no approval adapter is available/);
		expect(await marked(h)).toEqual([]);
	});
});

describe("unit digest reuse", () => {
	const BIG = { files: ["src/a.ts"], blob: "x".repeat(2001) };

	async function answerInForge(h: Change, facts: unknown = FACTS, digest = "d1", proposal?: boolean) {
		await h.world.setPermission("alice", "write");
		const r = await decidePick(h, { facts, digest, proposal });
		await h.world.postComment(h.n, "alice", "/livespec choose y");
		const status = await h.call("spec_status");
		expect(status.isError, textOf(status)).toBeFalsy();
		return r;
	}

	async function recordDecision(h: Change, data: Record<string, unknown>) {
		await appendSeed(h, { kind: "decision", id: "pick.U1", data: { point: "pick", subject: "U1", reason: "r", ...data } });
	}

	test("Human record carries the unit digest", async () => {
		const h = await change({ config: FORGE_CHAIN });
		await answerInForge(h);
		const [record] = await ofKind(h, "decision");
		expect(record?.data).toMatchObject({ source: "human", outcome: "y", digest: "d1" });
	});

	test("an amendment asker's answer is a proposal record", async () => {
		const h = await change({ config: FORGE_CHAIN });
		await answerInForge(h, FACTS, "d1", true);
		const [record] = await ofKind(h, "decision");
		expect(record?.data).toMatchObject({ source: "human", outcome: "y", digest: "d1", proposal: true });
	});

	test("Recorded answer reused", async () => {
		const h = await change({ config: FORGE_CHAIN });
		await answerInForge(h);
		const again = await decidePick(h, { digest: "d1" });
		expect(again).toMatchObject({ status: "decided", source: "human", outcome: "y", facts: FACTS });
		expect(await ofKind(h, "request")).toHaveLength(1);
	});

	test("Changed facts ask again", async () => {
		const h = await change({ config: FORGE_CHAIN });
		await answerInForge(h);
		const r = await decidePick(h, { facts: { files: ["src/b.ts"] }, digest: "d1" });
		expect(r).toMatchObject({ status: "pending" });
		expect(await ofKind(h, "request")).toHaveLength(2);
	});

	test("Changed contract asks again", async () => {
		const h = await change({ config: FORGE_CHAIN });
		await answerInForge(h);
		const r = await decidePick(h, { digest: "d2" });
		expect(r).toMatchObject({ status: "pending" });
		expect(await ofKind(h, "request")).toHaveLength(2);
	});

	test("Dismissed answer not reused", async () => {
		const h = await change({ config: FORGE_CHAIN });
		await answerInForge(h);
		await recordDecision(h, { source: "human", outcome: null, digest: "d1", facts: FACTS, reason: "dismissed by alice" });
		const r = await decidePick(h, { digest: "d1" });
		expect(r).toMatchObject({ status: "pending" });
		expect(await ofKind(h, "request")).toHaveLength(2);
	});

	test("Latest human record wins", async () => {
		const h = await change({ config: FORGE_CHAIN });
		await recordDecision(h, { source: "human", outcome: "x", digest: "d1", facts: FACTS, reason: "chosen" });
		await recordDecision(h, { source: "human", outcome: "y", digest: "d1", facts: { files: ["src/b.ts"] }, reason: "chosen" });
		const r = await decidePick(h, { digest: "d1" });
		expect(r).toMatchObject({ status: "pending" });
		expect(await ofKind(h, "request")).toHaveLength(1);
	});

	test("Newer rule record stops reuse", async () => {
		const h = await change({ config: FORGE_CHAIN });
		await answerInForge(h);
		await recordDecision(h, { source: "rule", outcome: "x", digest: "d1", facts: FACTS, reason: "rule" });
		const r = await decidePick(h, { digest: "d1" });
		expect(r).toMatchObject({ status: "pending" });
		expect(await ofKind(h, "request")).toHaveLength(2);
	});

	test("Large facts reused by hash", async () => {
		const h = await change({ config: FORGE_CHAIN });
		await answerInForge(h, BIG);
		const again = await decidePick(h, { facts: BIG, digest: "d1" });
		expect(again).toMatchObject({ status: "decided", source: "human", outcome: "y" });
		expect(await ofKind(h, "request")).toHaveLength(1);
	});
});

describe("built-in callers use the asker", () => {
	test("plan_units refuses before any write when a rule asks on the forge", async () => {
		registerRule("tags", tagsSchema, () => ({ ask: { summary: "Which tags?", options: OPTIONS, ...REC } }));
		const body = (head: string) => setHeaderLine(setHeaderLine(CHANGE_BODY_TEMPLATE, "Base", head), "Branch", CHANGE_BRANCH);
		const h = await change({ config: FORGE_CHAIN, body, phase: "plan" });
		h.git("config", `branch.${CHANGE_BRANCH}.livespecBase`, h.head);
		const before = await h.world.bodyOf(h.n);
		const unit = { title: "T", covers: ["c/Requirement: R"], files: ["a.ts"], done_means: [{ label: "a", text: "a" }], scenarios: [{ label: "a", ref: "t › a" }], depends: [], verify: "bun test" };
		const out = await h.call("plan_units", { units: [unit] });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("tags.U1");
		expect(textOf(out)).toContain("waits for a human answer");
		expect(await h.world.bodyOf(h.n)).toBe(before);
		expect(parseChange(before).units).toEqual([]);
		expect(await ofKind(h, "decision")).toEqual([]);
		expect(await ofKind(h, "request")).toHaveLength(1);
	});
});
