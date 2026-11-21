// Tests of the review round planner: which stage a spec_review call runs next, and its refusals.
import { beforeAll, describe, expect, test } from "vitest";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import type { ChangeState } from "../../src/engine/state-types.ts";
import type { MarkedComment } from "../../src/forge/markers.ts";
import { writeMarked } from "../../src/forge/markers.ts";
import { nextStage, roundNumber } from "../../src/review/round.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";
import { reviewed } from "../subagents/helpers.ts";
import { agg, aggregate, mark, run, stuckAnswer, stuckReport, verifier } from "./review-fixtures.ts";

let pack: Pack;
beforeAll(async () => {
	const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
	if (!loaded.ok) throw new Error("default pack must load");
	pack = loaded.pack;
});

const H = "f".repeat(40);
const READY = FIXTURE_BODY.replace("- [ ] Q1 (blocking)", "- [x] Q1 (blocking)").replace("- [ ] pending", "- [x] done");
const at = (marked: MarkedComment[], over: Partial<ChangeState> = {}, body = READY): ChangeState => stateFor("review", { marked, ...over }, body);
const review = (subject: "change" | `persona:${string}`, over: Record<string, unknown> = {}): MarkedComment => reviewed({ subject, unit: undefined, head: H, ...over });
const SELECTED = { selected: ["change", "persona:security-auditor"] as ("change" | `persona:${string}`)[], head: H };

describe("nextStage", () => {
	test("no round yet: start", () => {
		expect(nextStage(at([]), pack)).toEqual({ stage: "start" });
	});

	test("round started: review names the missing subjects", () => {
		expect(nextStage(at([run(SELECTED)]), pack)).toEqual({ stage: "review", missing: ["change", "persona:security-auditor"] });
	});

	test("Resumed after an interruption", () => {
		expect(nextStage(at([run(SELECTED), review("change")]), pack)).toEqual({ stage: "review", missing: ["persona:security-auditor"] });
	});

	test("Reviewer still missing: no aggregate", () => {
		expect(nextStage(at([run(SELECTED), review("change"), review("persona:security-auditor", { completed: false, status: "NEEDS_CONTEXT" })]), pack).stage).toBe("review");
	});

	test("every subject reviewed: aggregate", () => {
		expect(nextStage(at([run(SELECTED), review("change"), review("persona:security-auditor")]), pack)).toEqual({ stage: "aggregate" });
	});

	test("New HEAD restarts the round", () => {
		expect(nextStage(at([run({ ...SELECTED, round: 2, head: "a1" })]), pack)).toEqual({ stage: "start" });
	});

	test("aggregate posted: verify names the unverified keys, skipping the rest", () => {
		const a = aggregate([agg(), agg({ location: "x.ts:1", verify: "skipped-parent" }), agg({ location: "y.ts:1" })], 1, H);
		const v = verifier(`${a.commentId}:2`);
		expect(nextStage(at([run(SELECTED), a, v]), pack)).toEqual({ stage: "verify", missing: [`${a.commentId}:0`] });
	});

	test("a BLOCKED verifier counts: route", () => {
		const a = aggregate([agg()], 1, H);
		expect(nextStage(at([run(SELECTED), a, verifier(`${a.commentId}:0`, { status: "BLOCKED", completed: false, verdict: undefined })]), pack)).toEqual({ stage: "route" });
	});

	test("routed at HEAD: done", () => {
		const a = aggregate([], 1, H);
		expect(nextStage(at([run(SELECTED), a, run({ ...SELECTED, routed: true })]), pack)).toEqual({ stage: "done" });
	});

	test("routed at an older HEAD: start round 2", () => {
		const marked = [run({ ...SELECTED, head: "a1" }), aggregate([], 1, "a1"), run({ ...SELECTED, head: "a1", routed: true })];
		expect(nextStage(at(marked), pack)).toEqual({ stage: "start" });
		expect(roundNumber(marked)).toBe(2);
	});

	test("an aggregated round whose HEAD moved still finishes its verify and route", () => {
		const a = aggregate([agg()], 1, "a1");
		expect(nextStage(at([run({ ...SELECTED, head: "a1" }), a]), pack)).toEqual({ stage: "verify", missing: [`${a.commentId}:0`] });
	});

	test("a BLOCKED reviewer is not relaunched until a lifting stuck answer", () => {
		const blocked = review("persona:security-auditor", { status: "BLOCKED", completed: false });
		const base = [run(SELECTED), review("change"), blocked];
		const refused = nextStage(at(base), pack);
		expect(refused.stage).toBe("refused");
		expect(refused.reason).toContain("spec_stuck");
		expect(refused.reason).toContain("persona:security-auditor");
		expect(nextStage(at([...base, stuckReport("S1"), stuckAnswer("S1", "dismissed", "")]), pack).stage).toBe("refused");
		expect(nextStage(at([...base, stuckReport("S1"), stuckAnswer("S1")]), pack)).toEqual({ stage: "review", missing: ["persona:security-auditor"] });
	});
});

describe("nextStage feedback rounds", () => {
	const FB = { source: "pull-request" as const, selected: [], feedbackKeys: ["check:a1:ci/test"], head: "a1" };

	test("Feedback round kept on a new HEAD", () => {
		const fb = run({ ...FB, parentFindings: [] });
		expect(nextStage(at([fb]), pack)).toEqual({ stage: "aggregate" });
		const a = aggregate([agg({ verify: "skipped-parent" })], 1, "a1");
		expect(nextStage(at([fb, a]), pack)).toEqual({ stage: "route" });
		const routed = run({ ...FB, routed: true });
		expect(nextStage(at([fb, a, routed]), pack)).toEqual({ stage: "start" });
		expect(roundNumber([fb, a, routed])).toBe(2);
	});

	test("the cap blocks a new start but not a feedback round's aggregate and route", () => {
		const capped = { ...pack, loops: { ...pack.loops, review_rounds: 1 } };
		const fb = run(FB);
		expect(nextStage(at([fb]), capped)).toEqual({ stage: "aggregate" });
		const a = aggregate([agg({ verify: "skipped-parent" })], 1, "a1");
		expect(nextStage(at([fb, a]), capped)).toEqual({ stage: "route" });
		expect(nextStage(at([fb, a, run({ ...FB, routed: true })]), capped).stage).toBe("refused");
	});
});

describe("nextStage refusals", () => {
	const reason = (s: ChangeState): string => {
		const r = nextStage(s, pack);
		expect(r.stage).toBe("refused");
		return r.reason ?? "";
	};

	test("wrong phase", () => {
		expect(reason(stateFor("build", {}, READY))).toContain("review");
	});

	test("Unit not done", () => {
		expect(reason(at([], {}, READY.replace("Verify: `npm test -- ratelimit`\n- [x] done", "Verify: `npm test -- ratelimit`\n- [ ] pending")))).toContain("U3");
	});

	test("a pending unit does not stop a started round", () => {
		const body = READY.replace("Verify: `npm test -- ratelimit`\n- [x] done", "Verify: `npm test -- ratelimit`\n- [ ] pending");
		const a = aggregate([], 1, H);
		expect(nextStage(at([run(SELECTED), a], {}, body), pack)).toEqual({ stage: "route" });
	});

	test("No Base", () => {
		expect(reason(at([], {}, READY.replace(/^Base: .*\n/m, "")))).toContain("no Base");
	});

	test("dirty tree", () => {
		expect(reason(at([], { git: { branch: "b", head: H, dirty: true, specsChanged: false } }))).toContain("dirty");
	});

	test("open blocking question", () => {
		expect(reason(at([], {}, READY.replace("- [x] Q1 (blocking)", "- [ ] Q1 (blocking)")))).toContain("Q1");
	});

	test("unanswered stuck report", () => {
		expect(reason(at([], { iterations: { count: 0, cap: undefined, blocking: false, stuckOpen: "S2" } }))).toContain("S2");
	});

	test("pending blocking request", () => {
		const pending = [{ id: "r1", subject: "gate:review", mode: "blocking" }] as unknown as ChangeState["requests"]["pending"];
		expect(reason(at([], { requests: { pending, applying: [] } }))).toContain("gate:review");
	});

	test("a child question waits for subagent_answer", () => {
		const s = at([]);
		expect(reason({ ...s, subagents: { ...s.subagents, pending: { agentId: "agent-3", question: "q?" } } })).toContain("subagent_answer");
	});

	test("the cap blocks a start but not the later stages", () => {
		const capped = { ...pack, loops: { ...pack.loops, review_rounds: 1 } };
		const a = aggregate([agg({ verify: "skipped-parent" })], 1, "a1");
		const routed = [run({ ...SELECTED, head: "a1" }), a, run({ ...SELECTED, head: "a1", routed: true })];
		const r = nextStage(at(routed), capped);
		expect(r.stage).toBe("refused");
		expect(r.reason).toContain("spec_stuck");
		const b = aggregate([agg()], 1, "a1");
		expect(nextStage(at([run({ ...SELECTED, head: "a1" }), b]), capped).stage).toBe("verify");
		expect(nextStage(at([run({ ...SELECTED, head: "a1" }), b, verifier(`${b.commentId}:0`)]), capped).stage).toBe("route");
	});

	test("a stray decision comment changes nothing", () => {
		expect(nextStage(at([mark(writeMarked("decision", "tags.review", { point: "tags", subject: "review", source: "rule", outcome: [], reason: "r" }))]), pack)).toEqual({ stage: "start" });
	});
});

describe("dispatch outcomes of a stage", () => {
	const t = { role: "reviewer" as const, subject: "change" as const };
	const packet = { text: "", hash: "a".repeat(64), sources: [], skillPaths: [], cwd: "/", seen: [] };
	test.each([
		[{ kind: "question", id: "agent-1", text: "which?" }, "subagent_answer agent-1", undefined],
		[{ kind: "inline", reason: "disabled", packet }, "subagent_packet reviewer change, then subagent_record reviewer change", "subagent_packet reviewer change, then subagent_record reviewer change"],
		[{ kind: "sequential", reason: "moved" }, "subagent_record reviewer change", "subagent_packet reviewer change, then subagent_record reviewer change"],
		[{ kind: "stuck", reason: "NEEDS_CONTEXT 3 times" }, "spec_stuck", undefined],
		[{ kind: "blocked", reason: "no result" }, "BLOCKED", undefined],
		[{ kind: "cancelled", reason: "cancelled" }, "cancelled", undefined],
	] as const)("%o stops the call", async (outcome, text, inline) => {
		const { outcomeLine } = await import("../../src/review/stages.ts");
		const line = outcomeLine(t, outcome as never);
		expect(line.stop).toBe(true);
		expect(line.line).toContain(text);
		expect(line.inline).toBe(inline);
	});
});
