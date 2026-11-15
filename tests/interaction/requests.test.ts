import { describe, expect, test } from "vitest";
import { type MarkedComment, parseMarked } from "../../src/forge/markers.ts";
import type { Answered, RequestRecord } from "../../src/interaction/approver.ts";
import {
	type AnswerData,
	answerComment,
	newRequestId,
	readRequests,
	requestComment,
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
	snapshot: { target: "plan", digests: { U1: "a" }, failingWaivable: [] },
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

	test("request id matches the marker id pattern", () => {
		const id = newRequestId("gate:plan", NOW);
		expect(id).toBe(ID);
		expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
		expect(newRequestId("decide:tags.U3", NOW)).toBe(`decide-tags-U3.${NOW.getTime().toString(36)}`);
		expect(newRequestId("question:Q4", NOW)).toMatch(/^question-Q4\.[0-9a-z]+$/);
	});
});
