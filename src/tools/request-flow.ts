// Sending one approval request from a tool (design D2, D6): run the approver
// chain, report a forge request as pending, and complete an in-session answer
// at once. Shared by `spec_gate` and `unit_amend`.

import type { ChangeState } from "../engine/state-types.ts";
import type { Session } from "../hooks/session.ts";
import type { ApprovalRequest } from "../interaction/approver.ts";
import { runChain } from "../interaction/chain.ts";
import { completeAnswer } from "../interaction/complete.ts";
import { DuplicateRequestError } from "../interaction/forge.ts";
import { sessionCompletionCtx } from "../interaction/session-ctx.ts";
import { type ApproverCtx, approverFor } from "./approver-for.ts";
import { formatStep } from "./format-step.ts";
import { afterForgeWrite, currentChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";

/** The card's next step after a write, so the agent sees where the change stands. */
export function withStep(session: Session, text: string): string {
	const current = currentChange(session);
	return current.kind === "change" ? `${text}\n\n${formatStep(current.step, current.state)}` : text;
}

export type SendOptions = {
	/** The tool name, for refusal texts. */
	tool: string;
	/** What to ask for again when no adapter remained. */
	retry: string;
	/**
	 * "Answer later" handling, for question requests only: `hook` runs once before the next adapter gets
	 * the async request, and `text` is the (non-error) result when no adapter remained.
	 */
	deferred?: { hook: () => Promise<void>; text: string };
};

/** Sends `request` through the chain; a forge request is pending, an in-session answer is completed now. */
export async function sendRequest(w: WriteContext, state: ChangeState, request: ApprovalRequest, ctx: ApproverCtx, o: SendOptions): Promise<ToolResult<undefined>> {
	const n = state.issue.number;
	const { chain, adapters } = approverFor(w.session, ctx, n);
	let result: Awaited<ReturnType<typeof runChain>>;
	try {
		// Gate-like requests are never deferred: only question requests offer "answer later".
		result = await runChain(chain, adapters, request, { onDeferred: o.deferred?.hook ?? (async () => {}) });
	} catch (error) {
		if (error instanceof DuplicateRequestError) return toolResult(error.message, undefined, true);
		throw error;
	}
	if (result.status === "refused") return toolResult(`${o.tool} refused: ${result.message}.`, undefined, true);
	if (result.status === "deferred-all" && o.deferred) {
		await afterForgeWrite(w.session, n);
		return toolResult(withStep(w.session, o.deferred.text), undefined);
	}
	if (result.status === "deferred-all") return toolResult(`The ${request.subject} request was deferred with no adapter left; ${o.retry}.`, undefined, true);
	if (result.status === "pending") {
		await afterForgeWrite(w.session, n);
		return toolResult(withStep(w.session, `Requested ${request.subject} on the forge as ${result.requestId}; wait for the human's answer.`), undefined);
	}
	// `Completion.result` is already wrapped as untrusted where it holds forge text.
	const completion = await completeAnswer(sessionCompletionCtx(w.session, w.forge, w.pack, n, state.marked), request.record, result);
	await afterForgeWrite(w.session, n);
	return toolResult(withStep(w.session, completion.result), undefined);
}
