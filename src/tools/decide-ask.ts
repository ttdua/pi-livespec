// The application-boundary `ask` of the decision seam (design D10): a rule's
// `DecisionAsk` becomes a blocking `decide:<point>.<subject>` request, runs
// through the configured approver chain, and comes back as the seam's answer.
// An in-session answer is completed at once (the `decision` record with
// `source: human`); a forge request stays pending until a `/livespec choose`.

import { reusableAnswer } from "../decide/records.ts";
import { BEHAVIOR_POINT, type BehaviorItem } from "../docs/behavior-change.ts";
import type { AskRecorded, DecisionAsk, DecideDeps } from "../decide/seam.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { ApprovalRequest, Briefing, DecideSnapshot, Subject } from "../interaction/approver.ts";
import type { MarkedComment } from "../forge/markers.ts";
import { readOwnRecords } from "../ledger/records.ts";
import { validateBriefing } from "../interaction/briefing.ts";
import { openRequestFor, prepareRequest, readRequests } from "../interaction/requests.ts";
import type { ApproverCtx } from "./approver-for.ts";
import type { WriteContext } from "./guard.ts";
import { dispatchRequest } from "./request-flow.ts";


export type DecisionAsker = NonNullable<DecideDeps["ask"]>;

/**
 * The request for `intent`. Its kind is `stuck`: like a stuck report it is a choice among options, with
 * no gate digest and no waivable checks; adapters and completion route it by its `decide:` subject.
 */
export function decisionRequest(state: ChangeState, intent: DecisionAsk, now: Date, proposal = false): ApprovalRequest {
	const subject: Subject = `decide:${intent.point}.${intent.subject}`;
	const snapshot: DecideSnapshot = { point: intent.point, subject: intent.subject, facts: intent.facts, ...(intent.digest === undefined ? {} : { digest: intent.digest }) };
	if (proposal) snapshot.proposal = true;
	const files = behaviorFilesOf(intent);
	if (files !== undefined) snapshot.files = files;
	const { summary, options } = intent;
	const briefing = ruleBriefing(intent);
	const record = prepareRequest({ kind: "stuck", subject, mode: "blocking", options, ...(briefing ? { briefing } : {}), head: state.git.head, body: "", snapshot, summary, now });
	const phase = state.phase.kind === "ok" ? state.phase.id : "";
	return { id: record.id, kind: "stuck", subject, record, change: state.issue.number, phase, summary: record.summary, links: [], files: [], mode: "blocking", options, ...(briefing ? { briefing } : {}) };
}

/** The rule-authored briefing, only when the rule recommends an option; an invalid one is a programming error. */
function ruleBriefing(intent: DecisionAsk): Briefing | undefined {
	if (intent.recommended === undefined) return undefined;
	const raw = { summary: intent.summary, recommended: intent.recommended, rationale: intent.rationale };
	const briefing = validateBriefing(raw, intent.options.map((o) => o.id), { author: "rule" });
	if ("refused" in briefing) throw new Error(`decision \`${intent.point}\` ${briefing.refused}`);
	return briefing;
}

/** The item's files of a `behavior-change` intent, kept beside the facts so they survive `facts_hash`. */
function behaviorFilesOf(intent: DecisionAsk): string[] | undefined {
	if (intent.point !== BEHAVIOR_POINT) return undefined;
	const files = (intent.facts as Partial<BehaviorItem> | undefined)?.files;
	return Array.isArray(files) ? [...files] : undefined;
}

/** A recorded human answer for the intent's unit digest and facts, as an `AskRecorded`; undefined when there is none to reuse. */
function reuseAnswer(comments: MarkedComment[], intent: DecisionAsk): AskRecorded | undefined {
	if (intent.digest === undefined) return undefined;
	const record = reusableAnswer(comments, intent.point, intent.subject, intent.digest, intent.facts);
	if (record === undefined) return undefined;
	return { status: "recorded", outcome: record.outcome, reason: `reused ${record.reason}` };
}

/**
 * The `ask` a tool passes to `decide`. An open request for the same subject, read fresh from the
 * forge (the tool's snapshot may predate it), is pending, so no adapter asks twice for one subject. No available adapter, or a request deferred by every adapter, throws: the caller
 * refuses before writing, like any other rule failure. `proposal` (set by `unit_amend`) marks the answer's
 * record as a proposal, effective only once the amendment is approved.
 */
export function createDecisionAsker(w: WriteContext, state: ChangeState, ctx: ApproverCtx, o: { proposal?: boolean; now?: () => Date } = {}): DecisionAsker {
	const now = o.now ?? (() => new Date());
	return async (intent) => {
		const request = decisionRequest(state, intent, now(), o.proposal === true);
		// `whoami` first, so an unreachable forge fails the ask instead of reading no own records.
		const { login } = await w.forge.whoami();
		const { records: comments } = await readOwnRecords(w.forge, w.ledger, state.issue.number, { login });
		const reused = reuseAnswer(comments, intent);
		if (reused !== undefined) return reused;
		const open = openRequestFor(readRequests(comments), request.subject);
		if (open !== undefined) return { status: "pending", requestId: open };
		const result = await dispatchRequest(w, state, request, ctx, async () => {});
		switch (result.status) {
			case "completed":
				return result.answer;
			case "pending":
				return result;
			case "duplicate":
				return { status: "pending", requestId: result.pendingId };
			case "refused":
				throw new Error(`decision \`${intent.point}.${intent.subject}\` cannot ask a human: ${result.message}`);
			case "deferred-all":
				throw new Error(`decision \`${intent.point}.${intent.subject}\` was deferred with no adapter left`);
		}
	};
}
