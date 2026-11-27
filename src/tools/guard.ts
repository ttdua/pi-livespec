// Shared preconditions of the livespec tools: an initialized session, a valid
// flow pack, a resolved change and a writable forge. Each guard returns a
// refusal message instead of throwing, so tools answer with an error result.

import { formatPackError } from "../commands/messages.ts";
import type { Pack, PackError } from "../engine/pack-types.ts";
import type { OpenChange } from "../engine/resolve-change.ts";
import type { ChangeState, NextStep } from "../engine/state-types.ts";
import type { CachedForge } from "../forge/cache.ts";
import type { Ledger } from "../ledger/index.ts";
import type { Session } from "../hooks/session.ts";
import { type FixCard, untrusted } from "../hooks/phase-card.ts";
import { getSession } from "../hooks/session-store.ts";

export type Refusal = { ok: false; message: string };

export type ToolResult<D> = { content: { type: "text"; text: string }[]; details: D; isError: boolean };

const NOT_INITIALIZED = "livespec is not set up in this project: run /livespec init first.";
const PACK_INVALID = "The flow pack is invalid, so livespec computes nothing until it is fixed:";
const READ_ONLY =
	"The forge is in read-only mode: it could not be reached, so livespec writes are refused until a read succeeds. Retry once the forge is reachable.";
const NO_FORGE = "No forge is connected, so livespec writes are refused";
const ACCOUNT_BLOCKED = "livespec writes are refused because the forge account is not confirmed";
const NO_CHANGE = "No change is resolved on this branch: switch to a livespec/<name> branch or run change_start #N.";

export function toolResult<D>(text: string, details: D, isError = false): ToolResult<D> {
	return { content: [{ type: "text", text }], details, isError };
}

export function requireSession(): { ok: true; session: Session } | Refusal {
	const session = getSession();
	return session?.initialized ? { ok: true, session } : { ok: false, message: NOT_INITIALIZED };
}

/** The pack errors, each with file, line and column, as a refusal. */
export function requireValidPack(session: Session): { ok: true; pack: Pack } | Refusal {
	const loaded = session.pack;
	if (loaded.ok) return { ok: true, pack: loaded.pack };
	return { ok: false, message: packErrorsMessage(loaded.errors) };
}

function packErrorsMessage(errors: PackError[]): string {
	return [PACK_INVALID, ...errors.map((e) => `- ${formatPackError(e)}`)].join("\n");
}

/**
 * A forge that is connected, not blocked by the account and not in read-only mode. The account block
 * comes first: it holds until a new resolution, whatever the reads do. Call after `session.refresh()`.
 */
export function requireWritable(session: Session): { ok: true; forge: CachedForge } | Refusal {
	if (session.accountBlock !== undefined) return { ok: false, message: `${ACCOUNT_BLOCKED}: ${session.accountBlock}` };
	const forge = session.forge;
	if (forge === undefined) {
		// The error may carry forge text (an HTTP body), so it is data, not instructions.
		const reason = session.forgeError === undefined ? "." : `: ${untrusted(session.forgeError)}.`;
		return { ok: false, message: `${NO_FORGE}${reason}` };
	}
	if (forge.isReadOnly()) return { ok: false, message: READ_ONLY };
	return { ok: true, forge };
}

export type CurrentChange =
	| { kind: "change"; step: NextStep; state: ChangeState }
	| { kind: "list"; open: OpenChange[] }
	| { kind: "fix"; fix: FixCard }
	| { kind: "refused"; message: string };

/** The fix part of a fix card, without the shared card fields. */
function fixOf(card: FixCard): FixCard {
	return {
		slug: card.slug,
		...(card.outcome !== undefined ? { outcome: card.outcome } : {}),
		...(card.error !== undefined ? { error: card.error } : {}),
		...(card.empty ? { empty: true as const } : {}),
	};
}

/** The change of the session's current card, the open changes, or why neither is known. */
export function currentChange(session: Session): CurrentChange {
	const card = session.card;
	switch (card.kind) {
		case "change":
			return { kind: "change", step: card.step, state: card.state };
		case "list":
			return { kind: "list", open: card.open };
		case "fix":
			return { kind: "fix", fix: fixOf(card) };
		case "pack-errors":
			return { kind: "refused", message: packErrorsMessage(card.errors) };
		case "forge-unavailable":
			return { kind: "refused", message: `The forge is unavailable: ${card.message}` };
		case "change-error":
			return { kind: "refused", message: `The change is not resolved: ${card.message}` };
	}
}

/** The resolved change for tools that need one; the open-changes list counts as a refusal. */
export function requireChange(session: Session): { ok: true; step: NextStep; state: ChangeState } | Refusal {
	const current = currentChange(session);
	if (current.kind === "change") return { ok: true, step: current.step, state: current.state };
	if (current.kind === "fix") return { ok: false, message: `On fix/${current.fix.slug}: run fix_ship or change_new <name> --from-fix; there is no change issue.` };
	return { ok: false, message: current.kind === "list" ? NO_CHANGE : current.message };
}

export type WriteContext = { session: Session; pack: Pack; forge: CachedForge; ledger: Ledger };

/**
 * The preconditions of every forge-writing tool, in order: an initialized session, a valid pack, then
 * a fresh snapshot (which fetches the change's ledger and updates the read-only mode), a fetched or
 * known ledger, and a writable forge. Nothing is written and no branch changes before this returns ok.
 */
export async function prepareWrite(): Promise<({ ok: true } & WriteContext) | Refusal> {
	const s = requireSession();
	if (!s.ok) return s;
	const pack = requireValidPack(s.session);
	if (!pack.ok) return pack;
	await s.session.refresh();
	const ledger = await requireKnownLedger(s.session);
	if (!ledger.ok) return ledger;
	// A fix card reads no forge, so one tracked read brings the read-only mode up to date before a fix
	// write (fix_ship, change_new --from-fix); its failure only sets that mode, so it is ignored.
	if (s.session.card.kind === "fix") await s.session.forge?.whoami().catch(() => undefined);
	const writable = requireWritable(s.session);
	if (!writable.ok) return writable;
	return { ok: true, session: s.session, pack: pack.pack, forge: writable.forge, ledger: s.session.ledger };
}

/**
 * Refuses when the current change's ledger could not be fetched and no copy is known: an empty read
 * would look like "no records" and fork the state. The refresh already fetched, so a success is remembered.
 */
async function requireKnownLedger(session: Session): Promise<{ ok: true } | Refusal> {
	if (session.card.kind !== "change") return { ok: true };
	const n = session.card.state.issue.number;
	if ((await session.ledger.ensureFetched(n)) !== "unknown-offline") return { ok: true };
	return { ok: false, message: `the ledger of #${n} could not be fetched; reconnect and retry` };
}

/** Drops the comments cache of `issue` and rebuilds the card; every forge-writing tool calls it after a successful write. */
export async function afterForgeWrite(session: Session, issue: number): Promise<void> {
	await session.comments?.invalidate(issue);
	await session.refresh();
}

/** Rebuilds the card after a ledger append; the comments cache stays, since no forge comment changed. */
export async function afterLedgerWrite(session: Session, _issue: number): Promise<void> {
	await session.refresh();
}
