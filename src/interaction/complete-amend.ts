// Applying an amendment answer (design D9a, unit-planning "Unit amendments"):
// on approval, the body change, the decision records of the edited or added
// unit, any overrides, then the `amendment` result comment, written last.

import { parseChange } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import { decisionComment, type DecisionRecord } from "../decide/records.ts";
import { writeMarked } from "../forge/markers.ts";
import { amendedBody } from "./amend-body.ts";
import type { AmendSnapshot, Answered } from "./approver.ts";
import { type ApplyFn, editBody, postComment, readIssue, type Run } from "./complete-effects.ts";
import { applyOverrides } from "./complete-overrides.ts";

const isApproved = (a: Answered): boolean => a.outcome === "approved" || a.outcome === "approved_with_notes";

/** Whether a record for the same unit contract (digest) and outcome exists. */
function hasRecord(run: Run, r: DecisionRecord): boolean {
	return run.marked.some((m) => {
		const d = m.data as Partial<DecisionRecord> | null;
		return m.kind === "decision" && m.id === `${r.point}.${r.subject}` && d?.digest === r.digest && JSON.stringify(d?.outcome) === JSON.stringify(r.outcome);
	});
}

/** The snapshot's rule records, each once; like overrides they carry no `request` (see `readRequests`). */
async function postRecords(run: Run, records: DecisionRecord[]): Promise<void> {
	for (const { request: _request, ...r } of records) {
		if (!hasRecord(run, r)) await postComment(run, decisionComment(r));
	}
}

async function newDigest(run: Run, unit: string): Promise<string | undefined> {
	const u = parseChange((await readIssue(run)).body).units.find((x) => x.id === unit);
	return u ? unitDigest(u) : undefined;
}

export const applyAmend: ApplyFn = async (run, record) => {
	const { request, answer } = record;
	const s = request.snapshot as AmendSnapshot;
	const apply = record.verdict === "valid" && isApproved(answer);
	if (apply) {
		await editBody(run, (body) => amendedBody(body, s));
		await postRecords(run, s.records ?? []);
		await applyOverrides(run, answer);
	}
	const data: Record<string, unknown> = { request: request.id, action: s.action, unit: s.unit };
	if (s.oldDigest !== undefined) data.old = s.oldDigest;
	const digest = apply && s.action !== "drop" ? await newDigest(run, s.unit) : undefined;
	if (digest !== undefined) data.new = digest;
	Object.assign(data, { outcome: answer.outcome, by: answer.by, at: answer.at, adapter: answer.adapter });
	if (record.verdict === "superseded") data.superseded = true;
	return writeMarked("amendment", request.id, data);
};
