import { describe, expect, test } from "vitest";
import { validBriefing } from "../helpers/briefing.ts";
import { type MarkedComment, parseMarked } from "../../src/forge/markers.ts";
import { type Answered, isSubject, type RequestRecord } from "../../src/interaction/approver.ts";
import {
	type AnswerData,
	answerComment,
	newRequestId,
	openRequestFor,
	openRequests,
	prepareRequest,
	readRequests,
	type RequestsState,
	requestComment,
	snapshotOf,
} from "../../src/interaction/requests.ts";

const NOW = new Date("2026-11-15T10:00:00.000Z");
const ID = `gate-plan.${NOW.getTime().toString(36)}`;

const RECORD: RequestRecord = {
	id: ID,
	kind: "gate",
	subject: "gate:plan",
	mode: "blocking",
	head_sha: "f".repeat(40),
	gate_digest: "d".repeat(64),
	snapshot: { target: "plan", failingWaivable: [] },
	summary: "Approve plan?",
};

const ANSWER: Answered = { status: "answered", outcome: "approved", notes: "", by: "alice", at: NOW.toISOString(), adapter: "forge" };

/** A marked comment as `filterMarked` returns it, parsed from the real comment body. */
function fromBody(body: string, n: number): MarkedComment {
	const parsed = parseMarked(body);
	if (!parsed) throw new Error(`not a marked comment: ${body}`);
	return { commentId: `c${n}`, author: "bot", ...parsed };
}

function comments(...bodies: string[]): MarkedComment[] {
	return bodies.map(fromBody);
}

const answerData = (record: RequestRecord = RECORD): AnswerData => ({ request: record, answer: ANSWER, verdict: "valid" });

describe("readRequests", () => {
	test("request without answer is pending", () => {
		const state = readRequests(comments(requestComment(ID, RECORD, "Reply with /livespec approve.")));
		expect(state.applying).toEqual([]);
		expect(state.pending).toEqual([
			{ id: ID, subject: "gate:plan", kind: "gate", mode: "blocking", createdAt: NOW.toISOString(), data: RECORD },
		]);
	});

	test("answer without result is applying", () => {
		const state = readRequests(comments(requestComment(ID, RECORD, "text"), answerComment(ID, answerData())));
		expect(state.pending).toEqual([]);
		expect(state.applying).toEqual([{ id: ID, subject: "gate:plan", record: answerData() }]);
	});

	test("result with request id completes it", () => {
		const result = `<!-- livespec:gate:plan.${ID} -->\n\`\`\`yaml\nrequest: ${ID}\nphase: plan\noutcome: approved\n\`\`\``;
		const state = readRequests(comments(requestComment(ID, RECORD, "text"), answerComment(ID, answerData()), result));
		expect(state).toEqual({ pending: [], applying: [] });
	});

	test("in-session answer without request is applying", () => {
		const inSession = { ...RECORD, mode: "blocking" as const };
		const state = readRequests(comments(answerComment(ID, answerData(inSession))));
		expect(state.pending).toEqual([]);
		expect(state.applying.map((a) => [a.id, a.subject])).toEqual([[ID, "gate:plan"]]);
	});

	test("malformed id suffix does not throw", () => {
		const bad = "gate-plan.zzzzzzzzzzzz";
		const state = readRequests(comments(requestComment(bad, { ...RECORD, id: bad }, "text"), requestComment("gate-x.no_pe", { ...RECORD, id: "gate-x.no_pe" }, "t")));
		expect(state.pending.map((p) => [p.id, p.createdAt])).toEqual([
			[bad, ""],
			["gate-x.no_pe", ""],
		]);
	});

	test("request id matches the marker id pattern", () => {
		const id = newRequestId("gate:plan", NOW);
		expect(id).toBe(ID);
		expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
		expect(newRequestId("decide:tags.U3", NOW)).toBe(`decide-tags-U3.${NOW.getTime().toString(36)}`);
		expect(newRequestId("question:Q4", NOW)).toMatch(/^question-Q4\.[0-9a-z]+$/);
	});
});

describe("open requests", () => {
	test("pending then applying requests are open; openRequestFor finds either by subject", () => {
		const state = {
			pending: [{ id: "gate-plan.a", subject: "gate:plan", kind: "gate", mode: "blocking", createdAt: "", data: {} }],
			applying: [{ id: "question-Q1.b", subject: "question:Q1", record: {} }],
		} as unknown as RequestsState;
		expect(openRequests(state)).toEqual([{ id: "gate-plan.a", subject: "gate:plan" }, { id: "question-Q1.b", subject: "question:Q1" }]);
		expect(openRequestFor(state, "question:Q1")).toBe("question-Q1.b");
		expect(openRequestFor(state, "gate:define")).toBeUndefined();
	});
});

describe("subjects and typed snapshots", () => {
	test("old request comment with snapshot digests still parses", () => {
		const old = { ...RECORD, snapshot: { target: "plan", digests: { U1: "a" }, failingWaivable: [] } };
		const state = readRequests(comments(requestComment(ID, old as RequestRecord, "text")));
		expect(state.pending.map((r) => r.id)).toEqual([ID]);
	});

	test("request with an unknown subject prefix is ignored", () => {
		const unknown = { ...RECORD, subject: "deploy:x" } as unknown as RequestRecord;
		expect(readRequests(comments(requestComment(ID, unknown, "text"))).pending).toEqual([]);
	});

	test("isSubject accepts every subject LS-05 writes and nothing else", () => {
		for (const s of ["gate:plan", "gate:new-dependency", "amend:12", "question:Q3", "stuck:S1", "decide:difficulty.U1"]) expect(isSubject(s)).toBe(true);
		for (const s of ["deploy:x", "amend:x", "question:3", "stuck:", "gate:", "decide:", "plan"]) expect(isSubject(s)).toBe(false);
	});

	test("snapshotOf discriminates by subject", () => {
		const kinds = (["gate:plan", "amend:1", "question:Q1", "stuck:S1", "decide:tags.U1"] as const).map((subject) => snapshotOf({ ...RECORD, subject }).kind);
		expect(kinds).toEqual(["gate", "amend", "question", "stuck", "decide"]);
	});
});

const FAILING = { target: "plan", failingWaivable: ["size-limits"] };
const base = { mode: "blocking" as const, head: "f".repeat(40), body: "b", summary: "x", now: NOW };
const described = [{ id: "A", label: "Retry", description: "Retry the unit." }, { id: "B", label: "Re-plan", description: "Re-plan the unit." }];

describe("briefing on the record", () => {
	test("prepareRequest stores the briefing", () => {
		const briefing = { ...validBriefing("approve"), author: "agent" as const };
		const r = prepareRequest({ ...base, kind: "gate", subject: "gate:plan", snapshot: RECORD.snapshot, briefing });
		expect(r.briefing).toEqual(briefing);
	});

	test("reads a stored request without briefing", () => {
		const state = readRequests(comments(requestComment(ID, RECORD, "plain")));
		expect(state.pending.map((p) => p.id)).toEqual([ID]);
		expect(state.pending[0]?.data.briefing).toBeUndefined();
	});
});

describe("interaction contract", () => {
	const gate = { ...base, kind: "gate" as const, subject: "gate:plan" as const, snapshot: RECORD.snapshot };
	const stuck = { ...base, kind: "stuck" as const, subject: "stuck:S1" as const, snapshot: { id: "S1" } };
	const author = { author: "agent" as const };

	test("prepareRequest throws without recommended", () => {
		const briefing = { summary: "s", ...author };
		expect(() => prepareRequest({ ...stuck, options: described, briefing })).toThrow(/recommended/);
		expect(() => prepareRequest({ ...stuck, options: described })).toThrow(/recommended/);
	});

	test("prepareRequest throws without rationale", () => {
		expect(() => prepareRequest({ ...stuck, options: described, briefing: { summary: "s", recommended: "A", ...author } })).toThrow(/rationale/);
	});

	test("prepareRequest throws on an undescribed option", () => {
		const options = [{ id: "accept", label: "Accept" }];
		expect(() => prepareRequest({ ...gate, options, briefing: { ...validBriefing("accept"), ...author } })).toThrow(/option accept/);
	});

	test("prepareRequest throws on a recommendation that is not offered", () => {
		expect(() => prepareRequest({ ...stuck, options: described, briefing: { ...validBriefing("C"), ...author } })).toThrow(/not an offered choice/);
	});

	test("prepareRequest accepts a gate whose built-ins are undescribed", () => {
		expect(() => prepareRequest({ ...gate, briefing: { ...validBriefing("approve"), ...author } })).not.toThrow();
	});

	test("waive recommended on a gate with a failing check passes", () => {
		const options = [{ id: "waive", label: "Waive size-limits" }];
		expect(() => prepareRequest({ ...gate, snapshot: FAILING, options, briefing: { ...validBriefing("waive"), ...author } })).not.toThrow();
	});

	test("approve recommended while a check fails throws", () => {
		const options = [{ id: "waive", label: "Waive size-limits" }];
		expect(() => prepareRequest({ ...gate, snapshot: FAILING, options, briefing: { ...validBriefing("approve"), ...author } })).toThrow(/approve/);
	});

	test("the error names the subject and the field", () => {
		expect(() => prepareRequest({ ...gate, briefing: { summary: "s", ...author } })).toThrow("request gate:plan: briefing.recommended is required");
	});
});
