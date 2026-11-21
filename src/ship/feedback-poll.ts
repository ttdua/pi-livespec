// The pull request feedback poll (design D8): in `ship`, collects human feedback and failing checks of the open pull
// request and posts them as a `source: pull-request` review round, then marks review and ship stale and moves the
// change back to `review`. Single-flight per session; never throws: failures go to `session.record`.

import { advancePhase } from "../engine/advance.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { CachedForge } from "../forge/cache.ts";
import { filterMarked, type MarkedComment } from "../forge/markers.ts";
import type { Session } from "../hooks/session.ts";
import { staleComment } from "../interaction/stale.ts";
import { latestRun, reviewRunComment } from "../review/records.ts";
import { roundNumber } from "../review/round.ts";
import { afterForgeWrite } from "../tools/guard.ts";
import { collectFeedback, type FeedbackItem } from "./feedback.ts";
import { SHIP_PHASE } from "./phase.ts";

export type FeedbackPollResult = { ingested: number } | { failed: string } | { skipped: true };

const STEP = "feedback-poll";
const REVIEW_PHASE = "review";
const SKIPPED: FeedbackPollResult = { skipped: true };

type Target = { session: Session; forge: CachedForge; pack: Pack; state: ChangeState; pr: number; pushedHead: string };

/** Design D8 preconditions: ship, an open unmerged pull request with a known pushed head, a clean tree, a writable forge, no unrouted round. */
function pollTarget(session: Session): Target | undefined {
	const { forge, card } = session;
	if (!forge || forge.isReadOnly() || session.accountBlock !== undefined || !session.pack.ok) return undefined;
	if (card.kind !== "change") return undefined;
	const { state } = card;
	if (state.readOnly || state.phase.kind !== "ok" || state.phase.id !== SHIP_PHASE || state.git.dirty) return undefined;
	const { pr } = state;
	if (pr === undefined || pr.state !== "open" || pr.merged || pr.pushedHead === undefined) return undefined;
	if (unrouted(state.marked) && !interruptedRound(state.marked)) return undefined;
	return { session, forge, pack: session.pack.pack, state, pr: pr.number, pushedHead: pr.pushedHead };
}

const unrouted = (marked: MarkedComment[]): boolean => {
	const run = latestRun(marked);
	return run !== undefined && !run.routed;
};

/** An unrouted feedback round seen while still in `ship`: its stale comment or label move failed, so the poll finishes it. */
function interruptedRound(marked: MarkedComment[]): number | undefined {
	const run = latestRun(marked);
	return run !== undefined && !run.routed && run.source === "pull-request" ? run.round : undefined;
}

/** Keys every earlier feedback round ingested. */
function ingestedKeys(marked: MarkedComment[]): Set<string> {
	const keys = marked.flatMap((m) => (m.kind === "review-run" ? ((m.data as { feedbackKeys?: unknown }).feedbackKeys ?? []) : []));
	return new Set(keys.filter((k): k is string => typeof k === "string"));
}

const staleId = (round: number): string => `stale.feedback.${round}`;

/** The stale comment for review and ship (once per round), then the move to review. Idempotent, so a retry resumes. */
async function staleAndMove(t: Target, marked: MarkedComment[], round: number, count: number): Promise<void> {
	const n = t.state.issue.number;
	if (!marked.some((m) => m.kind === "stale" && m.id === staleId(round))) {
		const reason = `pull request #${t.pr} has ${count} new feedback item(s), ingested as review round ${round}`;
		await t.forge.createComment(n, staleComment(staleId(round), { reason, phases: [REVIEW_PHASE, SHIP_PHASE] }));
	}
	const moved = await advancePhase(t.forge, n, REVIEW_PHASE, t.pack);
	if (moved.status === "refused") t.session.record(STEP, moved.reason);
}

/** Posts the feedback round's `review-run`, then the stale comment and the move to review. */
async function postRound(t: Target, marked: MarkedComment[], items: FeedbackItem[]): Promise<void> {
	const round = roundNumber(marked);
	const head = t.state.git.head;
	const parentFindings = items.map((i) => i.finding);
	const feedbackKeys = items.map((i) => i.key);
	await t.forge.createComment(t.state.issue.number, reviewRunComment({ round, head, selected: [], tags: [], verify: {}, parentFindings, routed: false, source: "pull-request", feedbackKeys }));
	await staleAndMove(t, marked, round, items.length);
}

async function pollChange(t: Target): Promise<FeedbackPollResult> {
	const { login } = await t.forge.whoami();
	// Read the issue's own records fresh: another session may have posted a feedback round since the last refresh.
	const marked = filterMarked(await t.forge.listComments(t.state.issue.number), login).comments;
	const interrupted = interruptedRound(marked);
	if (interrupted !== undefined) {
		await staleAndMove(t, marked, interrupted, latestRun(marked)?.feedbackKeys?.length ?? 0);
		await afterForgeWrite(t.session, t.state.issue.number);
		return { ingested: 0 };
	}
	if (unrouted(marked)) return SKIPPED;
	const items = await collectFeedback(t.forge, t.pr, t.pushedHead, login, ingestedKeys(marked), (author) => t.forge.getPermission(author));
	if (items.length === 0) return { ingested: 0 };
	await postRound(t, marked, items);
	await afterForgeWrite(t.session, t.state.issue.number);
	return { ingested: items.length };
}

async function pollOnce(session: Session): Promise<FeedbackPollResult> {
	try {
		const target = pollTarget(session);
		return target === undefined ? SKIPPED : await pollChange(target);
	} catch (error) {
		return { failed: session.record(STEP, error) };
	}
}

/**
 * Polls the pull request's feedback into a review round (design D8). Concurrent callers in one session (parallel tool
 * calls, session start, `/livespec next`, `change_push`) await the same run. Polls from other sessions are not coordinated.
 */
export function pollFeedback(session: Session): Promise<FeedbackPollResult> {
	session.feedbackPollInFlight ??= pollOnce(session).finally(() => {
		session.feedbackPollInFlight = undefined;
	});
	return session.feedbackPollInFlight;
}
