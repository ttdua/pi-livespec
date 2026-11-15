// Polling approval requests (design D3): finish every applying request first,
// then match plain `/livespec …` command comments to pending requests, record
// and apply the first valid answer per request, and keep the ignored-command
// warnings for the card. Never throws: errors go to `session.record`.

import { basename } from "node:path";
import { parseChange } from "../core/change.ts";
import { reclassifyQuestion } from "../core/question-lines.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { CachedForge } from "../forge/cache.ts";
import { filterMarked, type MarkedComment } from "../forge/markers.ts";
import type { Comment } from "../forge/types.ts";
import type { Session } from "../hooks/session.ts";
import { type CompletionCtx, completeAnswer, finishApplying } from "./complete.ts";
import { type ClassChange, commandAuthors, matchCommands, readPermissions } from "./forge-match.ts";
import { readRequests } from "./requests.ts";

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

/** Drops the comments cache and reads the issue's comments from the forge. */
async function readFresh(t: Target): Promise<Fresh> {
	const n = t.state.issue.number;
	await t.session.comments?.invalidate(n);
	const [{ login }, comments] = await Promise.all([t.forge.whoami(), t.forge.listComments(n)]);
	return { comments, marked: filterMarked(comments, login).comments };
}

function completionCtx(t: Target, marked: MarkedComment[]): CompletionCtx {
	const ctx: CompletionCtx = { forge: t.forge, git: t.session.git, pack: t.pack, issue: t.state.issue.number, marked, root: t.session.cwd, now: () => new Date() };
	if (t.session.activeTree !== undefined) ctx.agentSkills = basename(t.session.activeTree);
	return ctx;
}

async function finishAll(t: Target): Promise<void> {
	const { marked } = await readFresh(t);
	if (readRequests(marked).applying.length === 0) return;
	const finished = await finishApplying(completionCtx(t, marked));
	for (const e of finished.errors) t.session.record(STEP, e);
}

/** `/livespec class` commands rewrite the question's class token; a conflict is retried by the next poll. */
async function applyClasses(t: Target, classes: ClassChange[]): Promise<void> {
	if (classes.length === 0) return;
	const n = t.state.issue.number;
	const issue = await t.forge.getIssue(n);
	const open = new Set(parseChange(issue.body).questions.filter((q) => !q.checked).map((q) => q.id));
	const body = classes.filter((c) => open.has(c.question)).reduce((b, c) => reclassifyQuestion(b, c.question, c.class), issue.body);
	if (body === issue.body) return;
	const written = await t.forge.updateIssueBody(n, body, issue.version);
	if (written.status === "conflict") t.session.record(STEP, "the issue changed while reclassifying a question; the next poll retries");
}

/** Matches commands to pending requests and completes each match; returns the ignored-command warnings. */
async function answerPending(t: Target): Promise<string[]> {
	const { comments, marked } = await readFresh(t);
	const pending = readRequests(marked).pending;
	if (pending.length === 0) return [];
	const { perms, warnings } = await readPermissions(t.forge, commandAuthors(comments, pending));
	const result = matchCommands(pending, comments, perms, { marked });
	await applyClasses(t, result.classes);
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

async function pollChange(t: Target): Promise<void> {
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
