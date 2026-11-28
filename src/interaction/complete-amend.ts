// Applying an amendment answer (design D9a, unit-planning "Unit amendments"):
// on approval, the body change, the decision records of the edited or added
// unit, any overrides, then the `amendment` result comment, written last.

import { parseChange } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import { currentDecision, decisionComment, type DecisionRecord } from "../decide/records.ts";
import { validApproval } from "../engine/locks.ts";
import { writeMarked } from "../forge/markers.ts";
import { amendedBody } from "./amend-body.ts";
import { snapshotOf } from "./requests.ts";
import { type ApplyFn, appendRecord, editBody, readIssue, type Run } from "./complete-effects.ts";
import { applyOverrides } from "./complete-overrides.ts";

/** Same point, subject, digest, outcome and source: posting `r` again would change nothing. */
function sameRecord(d: Partial<DecisionRecord> | undefined, r: DecisionRecord): boolean {
	return d?.point === r.point && d.subject === r.subject && d.digest === r.digest && d.source === r.source && JSON.stringify(d.outcome) === JSON.stringify(r.outcome);
}

/** Whether `r` is already U's effective decision for its digest. */
function isCurrent(run: Run, r: DecisionRecord): boolean {
	return r.digest !== undefined && sameRecord(currentDecision(run.marked, r.point, r.subject, r.digest), r);
}

/** Whether a retry of this completion already posted `r`: a matching record after the request's `answer` comment. */
function postedByThisAnswer(run: Run, requestId: string, r: DecisionRecord): boolean {
	const answer = run.marked.findIndex((m) => m.kind === "answer" && m.id === requestId);
	if (answer === -1) return false;
	return run.marked.slice(answer + 1).some((m) => m.kind === "decision" && sameRecord(m.data as Partial<DecisionRecord> | undefined, r));
}

/**
 * The snapshot's records (rule decisions and the amendment's human answers, now effective), each once; like
 * overrides they carry no `request` (see `readRequests`) and no `proposal`.
 */
async function postRecords(run: Run, requestId: string, records: DecisionRecord[]): Promise<void> {
	for (const { request: _request, proposal: _proposal, ...r } of records) {
		if (!isCurrent(run, r) && !postedByThisAnswer(run, requestId, r)) await appendRecord(run, decisionComment(r));
	}
}

async function newDigest(run: Run, unit: string): Promise<string | undefined> {
	const u = parseChange((await readIssue(run)).body).units.find((x) => x.id === unit);
	return u ? unitDigest(u) : undefined;
}

export const applyAmend: ApplyFn = async (run, record) => {
	const { request, answer } = record;
	const typed = snapshotOf(request);
	if (typed.kind !== "amend") throw new Error(`${request.subject} is not an amendment request`);
	const s = typed.snapshot;
	const apply = validApproval({ outcome: answer.outcome, superseded: record.verdict === "superseded" });
	if (apply) {
		await editBody(run, (body) => amendedBody(body, s));
		await postRecords(run, request.id, s.records ?? []);
		await applyOverrides(run, answer);
	}
	const data: Record<string, unknown> = { request: request.id, action: s.action, unit: s.unit };
	if (s.oldDigest !== undefined) data.old = s.oldDigest;
	const digest = apply && s.action !== "drop" ? await newDigest(run, s.unit) : undefined;
	if (digest !== undefined) data.new = digest;
	Object.assign(data, { outcome: answer.outcome, by: answer.by, at: answer.at, adapter: answer.adapter });
	if (record.verdict === "superseded") data.superseded = true;
	return { comment: writeMarked("amendment", request.id, data) };
};
