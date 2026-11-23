// Pull request feedback (design D7, D8): human review comments, conversation comments, review bodies and failing
// checks of the pushed head, mapped to findings with a key per item version.

import { parseMarked } from "../forge/markers.ts";
import type { Check, Comment, Forge, Review, ReviewComment } from "../forge/types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { prMarker } from "../review/effects.ts";
import { CHECK_PREFIX } from "../review/route.ts";
import type { Finding } from "../subagents/roles.ts";
import { writerLookup } from "./writers.ts";

export type FeedbackItem = { key: string; finding: Finding };

type FeedbackForge = Pick<Forge, "listComments" | "listReviews" | "listReviewComments" | "getChecks">;

const FIX = "Address the pull request feedback.";
/** The LS-08 review-comment marker without its key: `<!-- livespec:finding `. */
const FINDING_MARKER = prMarker("").slice(0, -" -->".length);

type Voice = { author: string; body: string };

/** Own: the current login wrote it and it carries a livespec marker; everything else is a human voice. */
export function isOwn(item: Voice, login: string): boolean {
	return item.author === login && (parseMarked(item.body) !== null || item.body.includes(FINDING_MARKER));
}

/** One review-run comment holds every item; its forge limit is 65 536 characters, so the texts share this budget. */
const TEXT_BUDGET = 40_000;
const MAX_TEXT = 4000;
const MIN_TEXT = 200;

/** Each text is cut so its escaped form fits `max` characters, with a pointer to the pull request, which keeps the whole text. */
function evidenceOf(v: Voice, pr: number, max: number): string {
	let keep = Math.min(v.body.length, max);
	while (keep < v.body.length && untrusted(v.body.slice(0, keep)).length > max) keep = Math.floor(keep * 0.8);
	const body = keep < v.body.length ? `${v.body.slice(0, keep)}… (truncated; see pr#${pr})` : v.body;
	return `${untrusted(body)} (by ${untrusted(v.author)})`;
}

function reviewCommentItem(pr: number, max: number, c: ReviewComment): FeedbackItem {
	const location = `${c.path}:${c.line}`;
	return { key: `review-comment:${c.id}@${c.updatedAt}`, finding: { severity: "WARNING", kind: "defect", location, evidence: evidenceOf(c, pr, max), fix: FIX, scope: "in-change" } };
}

const decisionFinding = (pr: number, max: number, v: Voice): Finding => ({ severity: "WARNING", kind: "other", location: `pr#${pr}`, evidence: evidenceOf(v, pr, max), fix: FIX, scope: "needs-decision" });

const commentItem = (pr: number, max: number, c: Comment): FeedbackItem => ({ key: `comment:${c.id}@${c.updatedAt}`, finding: decisionFinding(pr, max, c) });

const reviewItem = (pr: number, max: number, r: Review): FeedbackItem => ({ key: `review:${r.id}@${r.updatedAt}`, finding: decisionFinding(pr, max, r) });

function checkItem(pushedHead: string, c: Check): FeedbackItem {
	const evidence = `${untrusted(c.name)} failed${c.url === undefined ? "" : ` (${untrusted(c.url)})`}`;
	return { key: `check:${pushedHead}:${c.name}`, finding: { severity: "CRITICAL", kind: "defect", location: `${CHECK_PREFIX}${c.name}`, evidence, fix: FIX, scope: "in-change" } };
}

/** A failed permission read counts as no access (fail closed): the item is not ingested. */
function writerCheck(permission: (login: string) => Promise<string>): (author: string) => Promise<boolean> {
	const lookup = writerLookup(permission);
	return (author) => lookup(author).catch(() => false);
}

async function humanWriters<T extends Voice>(items: T[], login: string, isWriter: (author: string) => Promise<boolean>): Promise<T[]> {
	const humans = items.filter((i) => !isOwn(i, login));
	const writers = await Promise.all(humans.map((i) => isWriter(i.author)));
	return humans.filter((_, i) => writers[i]);
}

/** Failing checks of the pushed head, one per name (a re-run with the same name is the same item). */
function failingChecks(checks: Check[]): Check[] {
	const byName = new Map<string, Check>();
	for (const c of checks) if (c.state === "failure" && !byName.has(c.name)) byName.set(c.name, c);
	return [...byName.values()];
}

const hasLine = (c: ReviewComment): boolean => c.path !== "" && Number.isInteger(c.line) && c.line > 0;

/** A review comment with a path and line is a located defect; without a valid line it needs a decision, like a conversation comment. */
const reviewCommentFeedback = (pr: number, max: number, c: ReviewComment): FeedbackItem =>
	hasLine(c) ? reviewCommentItem(pr, max, c) : { key: `review-comment:${c.id}@${c.updatedAt}`, finding: decisionFinding(pr, max, c) };

/**
 * The feedback items not yet ingested, in order: review comments (with a location, else needing a decision), conversation comments, non-approved
 * review bodies, then failing checks of `pushedHead`. Only writers' (`write`/`admin`) human voices count.
 * Forge read failures propagate; the caller records them.
 */
export async function collectFeedback(
	forge: FeedbackForge,
	pr: number,
	pushedHead: string,
	login: string,
	ingested: Set<string>,
	permission: (login: string) => Promise<string>,
): Promise<FeedbackItem[]> {
	const [reviewComments, comments, reviews, checks] = await Promise.all([forge.listReviewComments(pr), forge.listComments(pr), forge.listReviews(pr), forge.getChecks(pushedHead)]);
	const isWriter = writerCheck(permission);
	const withBody = reviews.filter((r) => r.state !== "approved" && r.body.trim() !== "");
	const [byComment, byConversation, byReview] = [await humanWriters(reviewComments, login, isWriter), await humanWriters(comments, login, isWriter), await humanWriters(withBody, login, isWriter)];
	const max = Math.min(MAX_TEXT, Math.max(MIN_TEXT, Math.floor(TEXT_BUDGET / Math.max(1, byComment.length + byConversation.length + byReview.length))));
	const items = [
		...byComment.map((c) => reviewCommentFeedback(pr, max, c)),
		...byConversation.map((c) => commentItem(pr, max, c)),
		...byReview.map((r) => reviewItem(pr, max, r)),
		...failingChecks(checks.checks).map((c) => checkItem(pushedHead, c)),
	];
	return items.filter((i) => !ingested.has(i.key));
}
