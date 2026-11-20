// The settle hooks (design D13): before the agent settles, unfinished build work
// (a started unit, a dirty tree, a registered condition) asks for one
// continuation per user prompt; when it is still unfinished after that, an own
// `incomplete` comment records it, and a later settle with nothing unfinished
// clears it, whatever the phase. The hook fails open: errors are recorded.

import type { AgentBeforeSettleEvent, AgentBeforeSettleEventResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { type MarkedComment, writeMarked } from "../forge/markers.ts";
import type { Forge } from "../forge/types.ts";
import { isChildSession } from "../subagents/child.ts";
import { requireWritable } from "../tools/guard.ts";
import type { Session } from "./session.ts";
import { getSession } from "./session-store.ts";

export type SettleCondition = (state: ChangeState) => string | undefined;

export const SETTLE_MESSAGE_TYPE = "livespec-settle";
const INCOMPLETE_KIND = "incomplete";
const STEP = "settle";
const DIRTY_TREE = "uncommitted changes in the working tree";

const conditions = new Map<string, SettleCondition>();
/** Whether a continuation was requested since the session's agent last settled. */
const asked = new WeakMap<Session, boolean>();

/** Adds a condition whose message, when defined, is one unfinished item (LS-07's "review pending"). */
export function registerSettleCondition(name: string, fn: SettleCondition): void {
	conditions.set(name, fn);
}

export function resetSettleConditionsForTests(): void {
	conditions.clear();
}

// ---------------------------------------------------------------- pure

/** Settle applies in a `per: unit` phase, or in any phase while a unit is started. */
function applies(state: ChangeState, pack: Pack): boolean {
	const phase = state.phase.kind === "ok" ? state.phase.id : undefined;
	const perUnit = pack.phases.find((p) => p.id === phase)?.per === "unit";
	return perUnit || Object.keys(state.evidence.started).length > 0;
}

/** The unfinished items of a resolved change, in a fixed order; empty when settle does not apply. */
export function settleItems(state: ChangeState, pack: Pack): string[] {
	if (!applies(state, pack)) return [];
	const started = Object.keys(state.evidence.started).map((id) => `${id} is started`);
	const dirty = state.git.dirty ? [DIRTY_TREE] : [];
	const registered = [...conditions.values()].flatMap((fn) => fn(state) ?? []);
	return [...started, ...dirty, ...registered];
}

function continuationText(items: string[]): string {
	return ["livespec: this work is unfinished. Finish it before stopping (make a started unit pass, then run unit_finish; commit or discard changes), or say why it cannot be finished:", ...items.map((i) => `- ${i}`)].join("\n");
}

// ---------------------------------------------------------------- incomplete comment

/** Writes the own `incomplete` comment of the change, editing the existing one in place; `[]` clears it. */
async function writeIncomplete(forge: Forge, state: ChangeState, items: string[]): Promise<void> {
	const n = state.issue.number;
	const body = writeMarked(INCOMPLETE_KIND, String(n), { items, at: new Date().toISOString(), head_sha: state.git.head });
	const existing = state.marked.filter((m: MarkedComment) => m.kind === INCOMPLETE_KIND && m.id === String(n)).at(-1);
	if (!existing) {
		await forge.createComment(n, body);
		return;
	}
	// The edit needs the comment's current version, which MarkedComment does not carry.
	const current = (await forge.listComments(n)).find((c) => c.id === existing.commentId);
	if (!current) throw new Error(`incomplete comment ${existing.commentId} no longer exists on issue #${n}`);
	const result = await forge.updateComment(current.id, body, current.version);
	if (result.status === "conflict") throw new Error(`the incomplete comment on issue #${n} changed concurrently (${result.changed.join(", ")})`);
}

/** Writes through the session's writable forge; a refusal (read-only, no account) is recorded as a warning. */
async function recordIncomplete(session: Session, state: ChangeState, items: string[]): Promise<void> {
	const writable = requireWritable(session);
	if (!writable.ok) {
		session.record(STEP, `incomplete items not written: ${writable.message}`);
		return;
	}
	await writeIncomplete(writable.forge, state, items);
	await session.comments?.invalidate(state.issue.number);
}

// ---------------------------------------------------------------- hooks

type Settle = AgentBeforeSettleEventResult | undefined;
type CardInput = Session["card"];

/**
 * Why the refreshed card cannot tell what is unfinished: a forge that could not be read, or a change state
 * that is stale or read-only (own comments may be missing, so "nothing started" proves nothing).
 */
function unknownReason(card: CardInput): string | undefined {
	if (card.kind === "forge-unavailable") return `the forge is unavailable (${card.message})`;
	if (card.kind !== "change") return undefined;
	if (card.state.readOnly) return "the forge is in read-only mode";
	if (card.state.stale) return "the change state is stale";
	return undefined;
}

async function beforeSettle(session: Session, event: AgentBeforeSettleEvent): Promise<Settle> {
	await session.refresh();
	const card = session.card;
	const unknown = unknownReason(card);
	if (unknown !== undefined) {
		// Fail open: no continuation, no write, and the flag stays as it was.
		session.record(STEP, `unfinished work unknown: ${unknown}; nothing was written`);
		return undefined;
	}
	if (card.kind !== "change" || !session.pack.ok) return undefined;
	const items = settleItems(card.state, session.pack.pack);
	if (items.length === 0) {
		if (card.state.incomplete.length > 0) await recordIncomplete(session, card.state, []);
		return undefined;
	}
	if (asked.get(session) === true) {
		await recordIncomplete(session, card.state, items);
		return undefined;
	}
	asked.set(session, true);
	const message = { type: "custom_message" as const, customType: SETTLE_MESSAGE_TYPE, content: continuationText(items), display: true };
	return { entries: [...event.entries, message], continue: true };
}

export function registerSettleHooks(pi: ExtensionAPI): void {
	pi.on("agent_before_settle", async (event, ctx) => {
		// A child never owns the change: it must not refresh, write or continue the parent's work.
		if (isChildSession(ctx)) return undefined;
		if (event.outcome !== "completed") return undefined;
		const session = getSession();
		if (!session?.initialized) return undefined;
		try {
			return await beforeSettle(session, event);
		} catch (error) {
			session.record(STEP, error);
			return undefined;
		}
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (isChildSession(ctx)) return;
		const session = getSession();
		if (session) asked.delete(session);
	});
}
