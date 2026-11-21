// Validating an answer once, before it is recorded (design D2): a gate checks
// the waive rule, HEAD, the gate digest and the gate refusal conditions
// (ignoring the request itself), for every adapter alike; an amendment checks the affected unit's digest and done state and the
// validity of the resulting plan. Other kinds are always valid.

import { parseChange } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import { checkDoneMapsScenarios, validateUnits } from "../core/validate-units.ts";
import { runChecks } from "../engine/checks.ts";
import { gateRefusal } from "../engine/gates.ts";
import { gateDigest } from "../engine/locks.ts";
import { deriveCommentFacts, phaseFromLabels, readGitFacts, sectionPresence } from "../engine/snapshot.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { Issue } from "../forge/types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { amendedBody } from "./amend-body.ts";
import type { Answered, RequestRecord } from "./approver.ts";
import type { CompletionCtx } from "./complete-effects.ts";
import { snapshotOf } from "./requests.ts";
import { failingWaivableOf, unwaivedApproval } from "./waive-rule.ts";

export type Verdict = { verdict: "valid" } | { verdict: "superseded"; reason: string };

const VALID: Verdict = { verdict: "valid" };
const superseded = (reason: string): Verdict => ({ verdict: "superseded", reason });

/** The change state as `spec_gate` would see it now, from the issue, own comments and git. */
async function stateNow(ctx: CompletionCtx, issue: Issue): Promise<ChangeState> {
	const change = parseChange(issue.body);
	const facts = deriveCommentFacts(ctx.marked, change, { iterations: ctx.pack.loops.change_iterations, unitAttempts: ctx.pack.loops.unit_attempts, reviewRounds: ctx.pack.loops.review_rounds });
	const git = await readGitFacts(ctx.git, change.header.base);
	const snapshot: Omit<ChangeState, "checks"> = {
		issue: { number: issue.number, title: issue.title, labels: [...issue.labels], state: issue.state },
		phase: phaseFromLabels(issue.labels),
		change,
		sections: sectionPresence(issue.body, change),
		...facts,
		git: git.git,
		stale: false,
		readOnly: false,
		warnings: git.warnings,
		commandWarnings: [],
	};
	const ship = await ctx.shipFor?.(snapshot);
	return { ...snapshot, checks: await runChecks(ctx.pack, snapshot, { root: ctx.root, git: ctx.git, ...(ship === undefined ? {} : { ship }) }) };
}

async function validateGate(ctx: CompletionCtx, req: RequestRecord, ans: Answered, issue: Issue): Promise<Verdict> {
	const unwaived = unwaivedApproval(failingWaivableOf(req.snapshot), ans);
	if (unwaived !== undefined) return superseded(unwaived);
	if ((await ctx.git.head()) !== req.head_sha) return superseded("HEAD moved since the request");
	if (req.gate_digest !== undefined && gateDigest(issue.body) !== req.gate_digest) return superseded("the issue changed since the request");
	const typed = snapshotOf(req);
	if (typed.kind !== "gate") throw new Error(`${req.subject} is not a gate request`);
	const target = typed.snapshot.target;
	const refusal = gateRefusal(await stateNow(ctx, issue), ctx.pack, target, req.id);
	return refusal === undefined ? VALID : superseded(refusal);
}

function validateAmend(req: RequestRecord, issue: Issue): Verdict {
	const typed = snapshotOf(req);
	if (typed.kind !== "amend") throw new Error(`${req.subject} is not an amendment request`);
	const s = typed.snapshot;
	const name = untrusted(s.unit);
	const unit = parseChange(issue.body).units.find((u) => u.id === s.unit);
	if (s.action === "add" && unit) return superseded(`${name} is already in the body`);
	if (s.action !== "add") {
		if (!unit) return superseded(`${name} is no longer in the body`);
		if (s.oldDigest !== undefined && unitDigest(unit) !== s.oldDigest) return superseded(`${name} changed since the request`);
		if (s.oldDone !== undefined && unit.done !== s.oldDone) return superseded(`${name} was ${unit.done ? "ticked done" : "unticked"} since the request`);
	}
	const after = parseChange(amendedBody(issue.body, s));
	const errors = [...validateUnits(after), ...checkDoneMapsScenarios(after)].filter((r) => r.severity === "error");
	return errors.length === 0 ? VALID : superseded(`the amended plan is invalid: ${untrusted(errors.map((e) => e.message).join("; "))}`);
}

/** Whether the human's answer still applies to what they saw. Run once, before the answer is recorded. */
export async function validateAnswer(ctx: CompletionCtx, req: RequestRecord, ans: Answered): Promise<Verdict> {
	if (req.subject.startsWith("gate:")) return validateGate(ctx, req, ans, await ctx.forge.getIssue(ctx.issue));
	if (req.subject.startsWith("amend:")) return validateAmend(req, await ctx.forge.getIssue(ctx.issue));
	return VALID;
}
