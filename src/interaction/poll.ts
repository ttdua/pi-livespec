// Polling approval requests (design D3): finish every applying request first,
// then match plain `/livespec …` command comments to pending requests, record
// and apply the first valid answer per request, and keep the ignored-command
// warnings for the card. Never throws: errors go to `session.record`.

import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { CachedForge } from "../forge/cache.ts";
import type { MarkedComment } from "../forge/markers.ts";
import type { Comment } from "../forge/types.ts";
import type { Session } from "../hooks/session.ts";
import { readOwnRecords } from "../ledger/records.ts";
import { type CompletionCtx, completeAnswer, finishApplying } from "./complete.ts";
import { matchCommands } from "./forge-match.ts";
import { commandAuthors, readPermissions } from "./forge-permissions.ts";
import { readRequests } from "./requests.ts";
import { sessionCompletionCtx } from "./session-ctx.ts";

const STEP = "poll";

type Target = { session: Session; forge: CachedForge; pack: Pack; state: ChangeState };

/** The connected, writable change the snapshot shows with open requests; undefined means skip. */
function pollTarget(session: Session): Target | undefined {
	const { forge, card } = session;
	if (!forge || forge.isReadOnly() || session.accountBlock !== undefined || !session.pack.ok) return undefined;
	if (card.kind !== "change") return undefined;
	const { pending, applying } = card.state.requests;
	if (pending.length === 0 && applying.length === 0) return undefined;
	return { session, forge, pack: session.pack.pack, state: card.state };
}

type Fresh = { comments: Comment[]; marked: MarkedComment[] };

/** Drops the comments cache, reads the issue's comments from the forge and merges the own ones with the ledger. */
async function readFresh(t: Target): Promise<Fresh> {
	const n = t.state.issue.number;
	await t.session.comments?.invalidate(n);
	const [{ login }, comments] = await Promise.all([t.forge.whoami(), t.forge.listComments(n)]);
	const own = await readOwnRecords(t.forge, t.session.ledger, n, { comments, login });
	return { comments, marked: own.records };
}

function completionCtx(t: Target, marked: MarkedComment[]): CompletionCtx {
	return sessionCompletionCtx(t.session, t.forge, t.pack, t.state.issue.number, marked);
}

async function finishAll(t: Target): Promise<void> {
	const { marked } = await readFresh(t);
	if (readRequests(marked).applying.length === 0) return;
	const finished = await finishApplying(completionCtx(t, marked));
	for (const e of finished.errors) t.session.record(STEP, e);
}

/** Matches commands to pending requests and completes each match; returns the ignored-command warnings. */
async function answerPending(t: Target): Promise<string[]> {
	const { comments, marked } = await readFresh(t);
	const pending = readRequests(marked).pending;
	if (pending.length === 0) return [];
	const { perms, warnings } = await readPermissions(t.forge, commandAuthors(comments, pending));
	const result = matchCommands(pending, comments, perms, { marked });
	let current = marked;
	for (const match of result.matches) {
		try {
			await completeAnswer(completionCtx(t, current), match.request.data, match.answer);
		} catch (error) {
			t.session.record(STEP, error);
		}
		current = (await readFresh(t)).marked;
	}
	return [...warnings, ...result.warnings];
}

/**
 * Runs the first ledger fetch of the change before any read (ledger-store "Ledger fetched before use"):
 * an answer completed by a ledger entry only on origin must not be applied again. False, recorded, when
 * the ledger could not be fetched and no copy is known, so the poll skips this change.
 */
async function ledgerReady(t: Target): Promise<boolean> {
	const n = t.state.issue.number;
	if ((await t.session.ledger.ensureFetched(n)) !== "unknown-offline") return true;
	t.session.record(STEP, `the ledger of #${n} could not be fetched and no copy of it is known; approvals are polled once it is fetched`);
	return false;
}

async function pollChange(t: Target): Promise<void> {
	if (!(await ledgerReady(t))) return;
	await finishAll(t);
	t.session.commandWarnings = await answerPending(t);
	await t.session.comments?.invalidate(t.state.issue.number);
	await t.session.refresh();
}

/**
 * Finishes applying requests, then answers pending ones from command comments. Skips without a
 * writable forge, or when the snapshot shows no pending or applying request. Never throws.
 * Single-flight per session: concurrent callers (parallel tool calls, session start, `/livespec next`)
 * await the same run. Polls from other sessions or machines are not coordinated (known gap).
 */
export function pollApprovals(session: Session): Promise<void> {
	session.pollInFlight ??= pollOnce(session).finally(() => {
		session.pollInFlight = undefined;
	});
	return session.pollInFlight;
}

async function pollOnce(session: Session): Promise<void> {
	try {
		const target = pollTarget(session);
		if (!target) {
			session.commandWarnings = [];
			return;
		}
		await pollChange(target);
	} catch (error) {
		session.record(STEP, error);
	}
}
