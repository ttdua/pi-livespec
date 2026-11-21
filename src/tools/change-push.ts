// `change_push` (ship-phase "Push tool", design D5): polls pull request feedback, then — once every refusal is
// false — pushes the reviewed fix commits to the open pull request's branch through `guardedPush` and posts the
// `ship` record for the new pushed head. The whole call runs under the evidence lock.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { messageOf } from "../core/messages.ts";
import { validApproval } from "../engine/locks.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { withEvidenceLock } from "../evidence/lock.ts";
import { guardedPush } from "../guard/push.ts";
import { untrusted } from "../hooks/phase-card.ts";
import type { Session } from "../hooks/session.ts";
import { type ShipContext, shipContext } from "../ship/context.ts";
import { durableDocsRule } from "../ship/durable-docs.ts";
import { SHIP_PHASE } from "../ship/phase.ts";
import { cleanBranchRefusal, filesRefusal, shipPhaseRefusal } from "../ship/ship-refusals.ts";
import { postShipRecord } from "../ship/ship-writes.ts";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { withStep } from "./request-flow.ts";
import { childRefusal, type ToolCtx } from "./subagent-target.ts";

const TOOL = "change_push";
const REMOTE = "origin";

/** Polls the pull request's feedback (Task 9); `skipped` when there is nothing to poll. */
export type ShipPoll = (session: Session) => Promise<{ ingested: number } | { failed: string } | { skipped: true }>;

const refuse = (message: string): ToolResult<undefined> => toolResult(`${TOOL} refused: ${message} Nothing was pushed.`, undefined, true);

/** A failed poll, or one that ingested a feedback round, stops the push. */
async function pollRefusal(poll: ShipPoll, session: Session): Promise<string | undefined> {
	let result: Awaited<ReturnType<ShipPoll>>;
	try {
		result = await poll(session);
	} catch (error) {
		return `polling the pull request feedback failed: ${untrusted(messageOf(error))}.`;
	}
	if ("failed" in result) return `polling the pull request feedback failed: ${untrusted(result.failed)}.`;
	if ("ingested" in result && result.ingested > 0) return `new pull request feedback arrived (${result.ingested} comment(s) ingested as a feedback round): handle it with spec_review first.`;
	return undefined;
}

/** The open, unmerged pull request the `PR` line names, with the pushed head; or the refusal. */
function openPull(state: ChangeState): { pr: NonNullable<ChangeState["pr"]>; pushedHead: string } | string {
	const { pr } = state;
	if (pr === undefined) return "the issue has no readable PR line: run change_ship first.";
	if (pr.state !== "open" || pr.merged) return `pull request #${pr.number} is ${pr.merged ? "merged" : "closed"}, not open.`;
	if (pr.pushedHead === undefined) return `the pushed head of ${state.git.branch} is unknown: origin/${state.git.branch} does not exist; fetch it or run change_ship.`;
	return { pr, pushedHead: pr.pushedHead };
}

/** The ship gate is required when `needsShipGate` and no approved ship gate was given at HEAD. */
function reconfirmRefusal(state: ChangeState, context: ShipContext): string | undefined {
	if (!context.needsShipGate) return undefined;
	const gate = state.lock.gates[SHIP_PHASE];
	if (validApproval(gate) && gate?.headSha === state.git.head) return undefined;
	return `the commits since the pushed head change specs/ or the durable-docs confirmation items; the ship gate needs a valid approved result at ${state.git.head.slice(0, 7)}: request it with spec_gate ${SHIP_PHASE}.`;
}

/** The refusals that need the ship context: reviewed HEAD, Files, the pushed head as ancestor, durable-docs, re-confirmation. */
async function gitRefusal(session: Session, state: ChangeState, context: ShipContext, pushedHead: string): Promise<string | undefined> {
	if (!context.reviewed.ok) return `HEAD is not reviewed: ${context.reviewed.reason}.`;
	const files = filesRefusal(context.diff.files, state.change.units);
	if (files !== undefined) return files;
	const descends = await session.git.isAncestor(pushedHead, state.git.head).catch(() => false);
	if (!descends) return `the pushed head ${pushedHead.slice(0, 7)} is not an ancestor of HEAD ${state.git.head.slice(0, 7)}: ${REMOTE}/${state.git.branch} diverged from this branch; reconcile it before pushing.`;
	const errors = durableDocsRule(context.facts).errors;
	if (errors.length > 0) return `durable-docs reports: ${errors.join("; ")}.`;
	return reconfirmRefusal(state, context);
}

/** Push → `ship` record. */
async function publish(session: Session, state: ChangeState, context: ShipContext, pr: number): Promise<ToolResult<undefined>> {
	const n = state.issue.number;
	const { branch, head } = state.git;
	try {
		await guardedPush(session.exec, session.cwd, REMOTE, `HEAD:refs/heads/${branch}`);
	} catch (error) {
		return refuse(`pushing ${branch} failed: ${untrusted(messageOf(error))}.`);
	}
	const forge = session.forge;
	if (forge === undefined) return toolResult(withStep(session, `Pushed ${branch} at ${head.slice(0, 7)}, but there is no forge to post the ship record.`), undefined, true);
	const record = await postShipRecord(forge, n, { pr, pushedHead: head, confirmed: durableDocsRule(context.facts).confirm });
	await afterForgeWrite(session, n);
	if (!record.ok) return toolResult(`${TOOL} failed: ${record.message}`, undefined, true);
	return toolResult(withStep(session, `Pushed ${branch} at ${head.slice(0, 7)} to pull request #${pr} and recorded the ship record on #${n}.`), undefined);
}

/** Every refusal in order, then the nothing-to-push report and the publish. */
async function push(deps: { poll: ShipPoll }): Promise<ToolResult<undefined>> {
	const w = await prepareWrite();
	if (!w.ok) return refuse(w.message);
	const polled = await pollRefusal(deps.poll, w.session);
	if (polled !== undefined) return refuse(polled);
	const change = requireChange(w.session);
	if (!change.ok) return refuse(change.message);
	const { state } = change;
	const early = shipPhaseRefusal(state, TOOL);
	if (early !== undefined) return refuse(early);
	const open = openPull(state);
	if (typeof open === "string") return refuse(open);
	const local = cleanBranchRefusal(state);
	if (local !== undefined) return refuse(local);
	const context = await shipContext(w.session, state);
	if ("refused" in context) return refuse(context.refused);
	const git = await gitRefusal(w.session, state, context, open.pushedHead);
	if (git !== undefined) return refuse(git);
	if (open.pushedHead === state.git.head) return toolResult(withStep(w.session, `There is nothing to push: ${state.git.branch} is already at ${state.git.head.slice(0, 7)} on ${REMOTE}.`), undefined);
	return publish(w.session, state, context, open.pr.number);
}

export function runChangePush(_params: Record<string, never>, deps: { poll: ShipPoll }, ctx?: ToolCtx): Promise<ToolResult<undefined>> {
	const child = ctx === undefined ? undefined : childRefusal(TOOL, ctx);
	if (child) return Promise.resolve(child);
	return withEvidenceLock(() => push(deps));
}

export function registerChangePush(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Push the reviewed fix",
		description:
			"Push reviewed fix commits to the open pull request's branch and record the new pushed head. Polls pull request feedback first; refuses (pushing nothing) on new feedback or any unmet condition, and names the ship gate when the fix needs it again.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: { type: "object", properties: {} } as never,
		execute: (_id, params, _signal, _update, ctx) => runChangePush(params as Record<string, never>, { poll: async () => ({ skipped: true }) }, ctx as ToolCtx),
	});
}
