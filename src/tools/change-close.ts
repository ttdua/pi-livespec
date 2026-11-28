// `change_close` (change-close "Close tool", design D11): once the pull request is merged (or, with `abandon`, closed
// unmerged) posts the summary, ticks and possibly closes the initiative, closes the change issue and then emits the events.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { messageOf } from "../core/messages.ts";
import { withEvidenceLock } from "../evidence/lock.ts";
import { closeInitiative, closeRefusal, type CloseEvents, initiativeNumber, initiativeRefusal, postChangeSummary, summaryData } from "../ship/close.ts";
import type { Forge } from "../forge/types.ts";
import type { Session } from "../hooks/session.ts";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { childRefusal, type ToolCtx } from "./subagent-target.ts";

const TOOL = "change_close";

export type ChangeCloseParams = { abandon?: string };
type Emitter = { events: { emit: (name: string, data: unknown) => void } };

const refuse = (message: string): ToolResult<undefined> => toolResult(`${TOOL} refused: ${message} Nothing was written.`, undefined, true);

async function close(p: ChangeCloseParams, pi: Emitter): Promise<ToolResult<undefined>> {
	const w = await prepareWrite();
	if (!w.ok) return refuse(w.message);
	const change = requireChange(w.session);
	if (!change.ok) return refuse(change.message);
	const { state } = change;
	const abandon = typeof p.abandon === "string" ? p.abandon : undefined;
	const why = closeRefusal(state, abandon);
	if (why !== undefined) return refuse(why);
	const n = state.issue.number;
	const data = summaryData(state, state.pr, abandon);
	const initiative = initiativeNumber(state.change.header);
	if (abandon === undefined && initiative !== undefined) {
		const missing = await initiativeRefusal(w.forge, initiative, n).catch((error: unknown) => `initiative #${initiative} cannot be read (${messageOf(error)}).`);
		if (missing !== undefined) return refuse(missing);
	}
	let initiativeClosed: CloseEvents["initiativeClosed"];
	try {
		await postChangeSummary(w.forge, state, data);
		initiativeClosed = abandon === undefined && initiative !== undefined ? await closeInitiative(w.forge, initiative, n, data) : undefined;
		await closeChangeIssue(w.forge, n);
	} catch (error) {
		await refreshQuietly(w.session, n); // the failure reported is the write error; a refresh problem here adds nothing
		return toolResult(`${TOOL} failed: ${messageOf(error)}. Steps already done are kept; run ${TOOL} again.`, undefined, true);
	}
	// The issue is closed: from here every failure is reported, never an error result, and the events always go first.
	const closed = { change: n, ...(state.pr === undefined ? {} : { pr: state.pr.number }), ...(initiative === undefined ? {} : { initiative }), ...(abandon === undefined ? {} : { abandoned: true as const }) };
	const ledger = await removeLedgerQuietly(w, n, abandon);
	const problems = [emitQuietly(pi, { closed, ...(initiativeClosed === undefined ? {} : { initiativeClosed }) }), await refreshQuietly(w.session, n), ledger].filter((m): m is string => m !== undefined);
	const note = problems.length === 0 ? "" : ` Closed, but: ${problems.join("; ")}.`;
	return toolResult(`Closed change #${n}${abandon === undefined ? "" : ` (abandoned: ${abandon.trim()})`}.${note}`, undefined);
}

/**
 * Closes the change issue. A call that throws after the forge stored the close (a timeout) counts as closed once a
 * re-read shows the issue `closed`: a rerun could not resolve the change any more, so the events would never go out.
 */
async function closeChangeIssue(forge: Pick<Forge, "closeIssue" | "getIssue">, n: number): Promise<void> {
	try {
		await forge.closeIssue(n);
	} catch (error) {
		const state = await forge.getIssue(n).then((issue) => (issue.stale ? undefined : issue.state), () => undefined);
		if (state !== "closed") throw error;
	}
}

/**
 * Deletes the change ledger when `ledger.retain` is false (ledger-store "Ledger retention"). Skipped on `abandon` (kept by
 * the accepted limit) and when no local ledger ref exists (a retry). A failed remote delete is returned as a note.
 */
async function removeLedgerQuietly(w: WriteContext, n: number, abandon: string | undefined): Promise<string | undefined> {
	if (abandon !== undefined || w.session.config.project?.ledger.retain !== false) return undefined;
	try {
		// `tip` is the local ledger ref: absent on a retry that already deleted it, so there is nothing to remove.
		if ((await w.ledger.read(n)).tip === undefined) return undefined;
		const removed = await w.ledger.remove(n);
		if (removed.remote === "failed") return `the ledger of #${n} was not deleted from origin (${removed.message ?? "unknown error"})`;
		if (removed.remote === "moved") return `the ledger of #${n} moved on origin after the sync and was not deleted there${removed.message ? ` (${removed.message})` : ""}`;
		return removed.localKept || removed.message ? `the ledger of #${n}: ${removed.message ?? "local ref kept"}` : undefined;
	} catch (error) {
		return `the ledger of #${n} was not removed (${messageOf(error)})`;
	}
}

/** Emits each event in order; a failing listener is reported and does not stop the next event. */
function emitQuietly(pi: Emitter, events: CloseEvents): string | undefined {
	const errors: string[] = [];
	const send = (name: string, data: unknown): void => {
		try {
			pi.events.emit(name, data);
		} catch (error) {
			errors.push(`the ${name} event failed (${messageOf(error)})`);
		}
	};
	send("livespec:change-closed", events.closed);
	if (events.initiativeClosed !== undefined) send("livespec:initiative-closed", events.initiativeClosed);
	return errors.length === 0 ? undefined : errors.join("; ");
}

async function refreshQuietly(session: Session, n: number): Promise<string | undefined> {
	try {
		await afterForgeWrite(session, n);
		return undefined;
	} catch (error) {
		return `the session refresh failed (${messageOf(error)})`;
	}
}

export function runChangeClose(p: ChangeCloseParams, ctx: ToolCtx, pi: Emitter): Promise<ToolResult<undefined>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return Promise.resolve(child);
	return withEvidenceLock(() => close(p, pi));
}

export function registerChangeClose(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Close the change",
		description:
			"Close the change after a human merged its pull request: post the close summary, tick the initiative entry (closing the initiative when it was the last), close the change issue and emit the close events. With `abandon` (a reason) it instead closes a change whose pull request was closed without merge, or a change with no pull request after the new-dependency gate chose D drop, leaving the initiative entry unchecked.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: { type: "object", properties: { abandon: { type: "string" } } } as never,
		execute: (_id, params, _signal, _update, ctx) => runChangeClose(params as ChangeCloseParams, ctx as ToolCtx, pi as unknown as Emitter),
	});
}
