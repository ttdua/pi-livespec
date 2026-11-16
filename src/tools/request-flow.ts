// Sending one approval request from a tool (design D2, D6): run the approver
// chain, report a forge request as pending, and complete an in-session answer
// at once. Shared by `spec_gate`, `unit_amend`, `spec_question`, `spec_stuck`
// and the decision asker.

import type { ChangeState } from "../engine/state-types.ts";
import type { Session } from "../hooks/session.ts";
import type { Answered, ApprovalRequest } from "../interaction/approver.ts";
import { runChain } from "../interaction/chain.ts";
import { type Completion, completeAnswer } from "../interaction/complete.ts";
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

/** What one request came to: the chain's outcome, with an in-session answer already completed. */
export type Dispatched =
	| { status: "refused"; message: string }
	| { status: "duplicate"; pendingId: string; message: string }
	| { status: "deferred-all" }
	| { status: "pending"; requestId: string }
	| { status: "completed"; answer: Answered; completion: Completion };

/**
 * Runs `request` through the configured chain. A forge request is pending; an in-session answer is
 * completed at once. The card is refreshed after a pending request or a completion.
 */
export async function dispatchRequest(
	w: WriteContext,
	state: ChangeState,
	request: ApprovalRequest,
	ctx: ApproverCtx,
	onDeferred: () => Promise<void>,
): Promise<Dispatched> {
	const n = state.issue.number;
	const { chain, adapters } = approverFor(w.session, ctx, n);
	let result: Awaited<ReturnType<typeof runChain>>;
	try {
		result = await runChain(chain, adapters, request, { onDeferred });
	} catch (error) {
		if (error instanceof DuplicateRequestError) return { status: "duplicate", pendingId: error.pendingId, message: error.message };
		throw error;
	}
	if (result.status === "refused" || result.status === "deferred-all") return result;
	if (result.status === "pending") {
		await afterForgeWrite(w.session, n);
		return result;
	}
	const completion = await completeAnswer(sessionCompletionCtx(w.session, w.forge, w.pack, n, state.marked), request.record, result);
	await afterForgeWrite(w.session, n);
	return { status: "completed", answer: result, completion };
}

/** Sends `request` through the chain; a forge request is pending, an in-session answer is completed now. */
export async function sendRequest(w: WriteContext, state: ChangeState, request: ApprovalRequest, ctx: ApproverCtx, o: SendOptions): Promise<ToolResult<undefined>> {
	// Gate-like requests are never deferred: only question requests offer "answer later".
	const result = await dispatchRequest(w, state, request, ctx, o.deferred?.hook ?? (async () => {}));
	if (result.status === "duplicate") return toolResult(result.message, undefined, true);
	if (result.status === "refused") return toolResult(`${o.tool} refused: ${result.message}.`, undefined, true);
	if (result.status === "deferred-all" && o.deferred) {
		await afterForgeWrite(w.session, state.issue.number);
		return toolResult(withStep(w.session, o.deferred.text), undefined);
	}
	if (result.status === "deferred-all") return toolResult(`The ${request.subject} request was deferred with no adapter left; ${o.retry}.`, undefined, true);
	if (result.status === "pending") {
		return toolResult(withStep(w.session, `Requested ${request.subject} on the forge as ${result.requestId}; wait for the human's answer.`), undefined);
	}
	// `Completion.result` is already wrapped as untrusted where it holds forge text.
	return toolResult(withStep(w.session, result.completion.result), undefined);
}
