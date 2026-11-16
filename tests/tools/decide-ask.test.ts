// The application-boundary `ask` of the decision seam: a rule that asks reaches
// the human through the configured approver chain, and the answer (in session
// at once, or a forge command later) completes a `source: human` decision record.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { setHeaderLine } from "../../src/core/sections.ts";
import { registerBuiltinRules, registerRule, resetRulesForTests } from "../../src/decide/registry.ts";
import { tagsSchema } from "../../src/decide/rules/tags.ts";
import { decide } from "../../src/decide/seam.ts";
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
	{ id: "x", label: "Option X" },
	{ id: "y", label: "Option Y" },
];
const FACTS = { files: ["src/a.ts"] };

beforeEach(() => {
	resetRulesForTests();
	registerBuiltinRules();
	registerRule("pick", { validate() {} }, () => ({ ask: { summary: "Pick one for U1", options: OPTIONS } }));
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

/** Runs `decide("pick", …)` with the asker a tool would build. */
async function decidePick(h: Change) {
	const w = await prepareWrite();
	if (!w.ok) throw new Error(w.message);
	const c = requireChange(w.session);
	if (!c.ok) throw new Error(c.message);
	return decide("pick", FACTS, { config: { mode: "rule" }, subject: "U1", ask: createDecisionAsker(w, c.state, h.ctx) });
}

async function marked(h: Change): Promise<MarkedComment[]> {
	return filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
}
const ofKind = async (h: Change, kind: string) => (await marked(h)).filter((m) => m.kind === kind);

describe("decision asker", () => {
	test("Rule asks: the human selects in session", async () => {
		const ui: FakeUI = { hasUI: true, select: async (_title, options) => options.find((o) => o.endsWith("[y]")) };
		const h = await change({ config: SESSION_CHAIN, ui });
		const r = await decidePick(h);
		expect(r).toMatchObject({ status: "decided", outcome: "y", source: "human", facts: FACTS });
		expect(h.ctx.ui.select).toHaveBeenCalledWith("Pick one for U1", expect.arrayContaining(["Option X [x]", "Option Y [y]"]));
		const [record] = await ofKind(h, "decision");
		expect(record).toMatchObject({ id: "pick.U1", data: { point: "pick", subject: "U1", source: "human", outcome: "y", facts: FACTS } });
		const [answer] = await ofKind(h, "answer");
		expect((record?.data as { request: string }).request).toBe(answer?.id);
		expect(h.session.card.kind === "change" && h.session.card.state.requests).toEqual({ pending: [], applying: [] });
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
		expect(record).toMatchObject({ id: "pick.U1", data: { source: "human", outcome: "y", request: request?.id } });
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
		const existing = decisionRequest(stale.state, { point: "pick", subject: "U1", facts: FACTS, summary: "Pick one for U1", options: OPTIONS }, new Date(0));
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("request", existing.id, { ...existing.record, id: undefined }));
		const r = await decide("pick", FACTS, { config: { mode: "rule" }, subject: "U1", ask: createDecisionAsker(w, stale.state, h.ctx) });
		expect(r).toEqual({ status: "pending", requestId: existing.id });
		expect(h.ctx.ui.select).not.toHaveBeenCalled();
		expect((await marked(h)).map((m) => m.kind)).toEqual(["request"]);
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

describe("built-in callers stay rule-only", () => {
	test("plan_units refuses before any write when a rule asks", async () => {
		registerRule("tags", tagsSchema, () => ({ ask: { summary: "Which tags?", options: OPTIONS } }));
		const body = (head: string) => setHeaderLine(setHeaderLine(CHANGE_BODY_TEMPLATE, "Base", head), "Branch", CHANGE_BRANCH);
		const h = await change({ config: FORGE_CHAIN, body, phase: "plan" });
		h.git("config", `branch.${CHANGE_BRANCH}.livespecBase`, h.head);
		const before = await h.world.bodyOf(h.n);
		const unit = { title: "T", covers: ["c/Requirement: R"], files: ["a.ts"], done_means: [{ label: "a", text: "a" }], scenarios: [{ label: "a", ref: "t › a" }], depends: [], verify: "bun test" };
		const out = await h.call("plan_units", { units: [unit] });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("asks a human");
		expect(await h.world.bodyOf(h.n)).toBe(before);
		expect(parseChange(before).units).toEqual([]);
		expect(await marked(h)).toEqual([]);
	});
});
