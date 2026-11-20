// Applying a gate answer (design D7): overrides on an approved plan gate, a
// `stale` comment on changes requested, then the `gate` result comment, which
// the dispatcher writes last. The phase advance is derived by `nextStep`.

import { parseChange } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import { validApproval } from "../engine/locks.ts";
import { writeMarked } from "../forge/markers.ts";
import type { AdapterName, Answered, GateSnapshot, RequestRecord } from "./approver.ts";
import { type ApplyFn, phasesAfter, postOnce, readIssue, type Run } from "./complete-effects.ts";
import { applyOverrides } from "./complete-overrides.ts";
import { type AnswerData, snapshotOf } from "./requests.ts";
import { WAIVE } from "./waive-rule.ts";

const PLAN = "plan";

/** The gate data of design D2's `gate` marker; `adapter` may be `livespec` for a self gate. */
export type GateCommentInput = {
	request?: string;
	target: string;
	isPhase: boolean;
	answer: Omit<Answered, "status" | "adapter"> & { adapter: AdapterName | "livespec" };
	headSha: string;
	waivers: string[];
	superseded?: boolean;
	locked?: Record<string, string>;
	agentSkills?: string;
	/** Keys of the subagent findings the gate payload listed. */
	findings?: string[];
};

/** The `gate` result comment, id `<phase|gate>.<request id | self-<base36 ms>>`. */
export function gateComment(id: string, g: GateCommentInput): string {
	const a = g.answer;
	const data: Record<string, unknown> = {};
	if (g.request !== undefined) data.request = g.request;
	data[g.isPhase ? "phase" : "gate"] = g.target;
	data.outcome = a.outcome;
	if (a.choice !== undefined) data.choice = a.choice;
	Object.assign(data, { notes: a.notes, by: a.by, at: a.at, adapter: a.adapter, head_sha: g.headSha, waivers: g.waivers });
	if (a.answerComment) data.answer_comment = a.answerComment;
	if (g.superseded) data.superseded = true;
	if (g.locked) data.locked = g.locked;
	if (g.agentSkills !== undefined) data.agent_skills = g.agentSkills;
	if (g.findings !== undefined && g.findings.length > 0) data.findings = g.findings;
	return writeMarked("gate", `${g.target}.${id}`, data);
}

function gateSnapshotOf(request: RequestRecord): GateSnapshot {
	const typed = snapshotOf(request);
	if (typed.kind !== "gate") throw new Error(`${request.subject} is not a gate request`);
	return typed.snapshot;
}

async function writeStale(run: Run, request: RequestRecord, target: string): Promise<void> {
	const phases = phasesAfter(run.ctx.pack, target);
	if (phases.length === 0) return;
	const data = { reason: `${request.subject} changes requested`, phases, units: [], after_plan: false };
	await postOnce(run, "stale", request.id, writeMarked("stale", request.id, data));
}

async function lockedDigests(run: Run): Promise<Record<string, string>> {
	const units = parseChange((await readIssue(run)).body).units;
	return Object.fromEntries(units.map((u) => [u.id, unitDigest(u)]));
}

export const applyGate: ApplyFn = async (run, record: AnswerData) => {
	const { request, answer } = record;
	const target = gateSnapshotOf(request).target;
	const isPhase = run.ctx.pack.phases.some((p) => p.id === target);
	const superseded = record.verdict === "superseded";
	const approvedPlan = validApproval({ outcome: answer.outcome, superseded }) && target === PLAN;
	if (approvedPlan) await applyOverrides(run, answer);
	if (!superseded && answer.outcome === "changes_requested" && isPhase) await writeStale(run, request, target);
	const input: GateCommentInput = {
		request: request.id,
		target,
		isPhase,
		answer,
		headSha: request.head_sha,
		waivers: !superseded && answer.choice === WAIVE ? [...gateSnapshotOf(request).failingWaivable] : [],
	};
	const shown = gateSnapshotOf(request).findings;
	if (shown !== undefined) input.findings = shown;
	if (superseded) input.superseded = true;
	if (approvedPlan) {
		input.locked = await lockedDigests(run);
		if (run.ctx.agentSkills !== undefined) input.agentSkills = run.ctx.agentSkills;
	}
	return gateComment(request.id, input);
};
