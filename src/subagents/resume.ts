// Getting a child that ended without a usable result back on track: resume the same child, and only when that fails launch one fallback.

import { dispatchComment } from "./records.ts";
import {
	abortChildOnCancel, cancelledOutcome, type DispatchDeps, type DispatchOutcome, type DispatchRequest, finish, isCancelled, launch, type Respawn, type Run, runFacts, waitFor,
} from "./dispatch.ts";
import type { RecordLike } from "./executor.ts";
import type { DispatchHistory } from "./result.ts";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Resumes `agentId` with `message` and waits for its next run; a refused or failed resume returns its reason as a string. A cancel aborts the child. */
export async function resumeChild(deps: Pick<DispatchDeps, "service" | "signal">, agentId: string, message: string): Promise<RecordLike | string> {
	const disposeCancel = abortChildOnCancel(deps.service, agentId, deps.signal);
	try {
		const resumed = (await deps.service.resume(agentId, message)) as { kind?: string; reason?: string } | undefined;
		if (resumed?.kind === "refused") return `the executor refused to resume ${agentId} (${resumed.reason ?? "no reason"})`;
		return await waitFor(deps.service, agentId, deps.signal);
	} catch (error) {
		return `the executor could not resume ${agentId}: ${messageOf(error)}`;
	} finally {
		disposeCancel();
	}
}

/** What the child is told when its run ended without a usable result. */
export const retryMessage = (reason: string): string =>
	`Your run ended without a usable result: ${reason}. Do not redo finished work. Submit your result now with the result tool; if you cannot finish, submit status BLOCKED with reason and evidence.`;

export type RetryStep = { kind: "next"; run: Run; record: RecordLike; respawn?: Respawn } | { kind: "stop"; outcome: DispatchOutcome };

/** Resumes the same child; when that is refused or fails, launches one fallback child (never a second) and records the swap with a `RETRY` record. */
export async function retryRun(deps: DispatchDeps, request: DispatchRequest, run: Run, reason: string, shown: string, seen: DispatchHistory): Promise<RetryStep> {
	const resumed = await resumeChild(deps, run.agentId, retryMessage(reason));
	if (isCancelled(deps.signal)) return { kind: "stop", outcome: cancelledOutcome(run.agentId) };
	if (typeof resumed !== "string") return { kind: "next", run, record: resumed };
	if (seen.respawned) return { kind: "stop", outcome: await finish(deps, runFacts(request, run), request.packet.cwd, run.facts, { kind: "blocked", reason: `${shown}; ${resumed}` }) };
	deps.service.abort(run.agentId);
	const again = await launch(deps, request, run.agentSource);
	if (again.kind === "stop") return again;
	if (isCancelled(deps.signal)) return { kind: "stop", outcome: cancelledOutcome(again.run.agentId) };
	const failure = `${reason}; ${resumed}`;
	await deps.post(dispatchComment({
		status: "RETRY", role: request.role, ...(request.unit === undefined ? {} : { unit: request.unit }), ...(request.subject === undefined ? {} : { subject: request.subject }),
		...(request.finding === undefined ? {} : { finding: request.finding }), agentId: run.agentId, newAgentId: again.run.agentId, attempt: request.attempt, reason: failure,
	}));
	return { kind: "next", run: again.run, record: again.record, respawn: { from: run.agentId, to: again.run.agentId, reason: failure } };
}
