import { describe, expect, test } from "vitest";
import { blockingRequests } from "../../src/engine/request-mode.ts";
import type { ChangeState } from "../../src/engine/state-types.ts";
import type { Answered, RequestKind, RequestRecord, Subject } from "../../src/interaction/approver.ts";
import type { AppliedAnswer, PendingRequest } from "../../src/interaction/requests.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";

const HEAD = "f".repeat(40);
const WITH_Q3 = FIXTURE_BODY.replace("## Questions\n", "## Questions\n- [ ] Q3 (non-blocking): x\n");

function pending(subject: Subject, kind: RequestKind, mode: "blocking" | "async"): PendingRequest {
	const id = `${subject.replace(/[^A-Za-z0-9]+/g, "-")}.lx3k2a`;
	const data: RequestRecord = { id, kind, subject, mode, head_sha: HEAD, snapshot: { id: "S1" }, summary: "s" };
	return { id, subject, kind, mode, createdAt: "", data };
}

function applying(subject: Subject): AppliedAnswer {
	const id = `${subject.replace(/[^A-Za-z0-9]+/g, "-")}.lx3k2b`;
	const req: RequestRecord = { id, kind: "question", subject, mode: "blocking", head_sha: HEAD, snapshot: { id: "S1" }, summary: "s" };
	const answer: Answered = { status: "answered", outcome: "approved", notes: "", by: "alice", at: "t", adapter: "forge" };
	return { id, subject, record: { request: req, answer, verdict: "valid" } };
}

function withRequests(p: PendingRequest[], a: AppliedAnswer[] = []): ChangeState {
	return stateFor("define", { requests: { pending: p, applying: a } }, WITH_Q3);
}

describe("blockingRequests", () => {
	test("a pending non-blocking question does not block", () => {
		expect(blockingRequests(withRequests([pending("question:Q3", "question", "async")]))).toEqual([]);
	});

	test("the live class wins over the stored mode", () => {
		expect(blockingRequests(withRequests([pending("question:Q3", "question", "blocking")]))).toEqual([]);
		const q1 = pending("question:Q1", "question", "async");
		expect(blockingRequests(withRequests([q1]))).toEqual([{ id: q1.id, subject: "question:Q1" }]);
	});

	test("a request for a missing question blocks", () => {
		const q9 = pending("question:Q9", "question", "async");
		expect(blockingRequests(withRequests([q9]))).toEqual([{ id: q9.id, subject: "question:Q9" }]);
	});

	test("non-question requests block whatever their stored mode", () => {
		const list = [pending("gate:plan", "gate", "async"), pending("amend:1", "gate", "async"), pending("stuck:S1", "stuck", "async"), pending("decide:tags.U1", "gate", "async")];
		expect(blockingRequests(withRequests(list))).toEqual(list.map((r) => ({ id: r.id, subject: r.subject })));
	});

	test("applying requests always block", () => {
		const p = pending("gate:plan", "gate", "blocking");
		const a = applying("question:Q3");
		expect(blockingRequests(withRequests([p], [a]))).toEqual([{ id: p.id, subject: "gate:plan" }, { id: a.id, subject: "question:Q3" }]);
	});
});
