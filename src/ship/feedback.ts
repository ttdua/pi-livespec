// Pull request feedback (design D7, D8): human review comments, conversation comments, review bodies and failing
// checks of the pushed head, mapped to findings with a key per item version.

import { parseMarked } from "../forge/markers.ts";
import type { Check, Comment, Forge, Review, ReviewComment } from "../forge/types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { prMarker } from "../review/effects.ts";
import type { Finding } from "../subagents/roles.ts";

export type FeedbackItem = { key: string; finding: Finding };

type FeedbackForge = Pick<Forge, "listComments" | "listReviews" | "listReviewComments" | "getChecks">;

const FIX = "Address the pull request feedback.";
const WRITERS = new Set(["write", "admin"]);
/** The LS-08 review-comment marker without its key: `<!-- livespec:finding `. */
const FINDING_MARKER = prMarker("").slice(0, -" -->".length);

type Voice = { author: string; body: string };

/** Own: the current login wrote it and it carries a livespec marker; everything else is a human voice. */
export function isOwn(item: Voice, login: string): boolean {
	return item.author === login && (parseMarked(item.body) !== null || item.body.includes(FINDING_MARKER));
}

const evidenceOf = (v: Voice): string => `${untrusted(v.body)} (by ${untrusted(v.author)})`;

function reviewCommentItem(c: ReviewComment): FeedbackItem {
	const location = `${c.path}:${c.line}`;
	return { key: `review-comment:${c.id}@${c.updatedAt}`, finding: { severity: "WARNING", kind: "defect", location, evidence: evidenceOf(c), fix: FIX, scope: "in-change" } };
}

const decisionFinding = (pr: number, v: Voice): Finding => ({ severity: "WARNING", kind: "other", location: `pr#${pr}`, evidence: evidenceOf(v), fix: FIX, scope: "needs-decision" });

const commentItem = (pr: number, c: Comment): FeedbackItem => ({ key: `comment:${c.id}@${c.updatedAt}`, finding: decisionFinding(pr, c) });

const reviewItem = (pr: number, r: Review): FeedbackItem => ({ key: `review:${r.id}@${r.updatedAt}`, finding: decisionFinding(pr, r) });

function checkItem(pushedHead: string, c: Check): FeedbackItem {
	const evidence = `${untrusted(c.name)} failed${c.url === undefined ? "" : ` (${untrusted(c.url)})`}`;
	return { key: `check:${pushedHead}:${c.name}`, finding: { severity: "CRITICAL", kind: "defect", location: `check:${c.name}`, evidence, fix: FIX, scope: "in-change" } };
}

/** `permission` once per author for this call; a failed read counts as no access (fail closed). */
function writerCheck(permission: (login: string) => Promise<string>): (author: string) => Promise<boolean> {
	const memo = new Map<string, Promise<boolean>>();
	return (author) => {
		let found = memo.get(author);
		if (found === undefined) {
			found = permission(author).then((p) => WRITERS.has(p), () => false);
			memo.set(author, found);
		}
		return found;
	};
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

/**
 * The feedback items not yet ingested, in order: review comments with a location, conversation comments, non-approved
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
	const located = reviewComments.filter((c) => c.path !== "" && Number.isInteger(c.line) && c.line > 0);
	const withBody = reviews.filter((r) => r.state !== "approved" && r.body.trim() !== "");
	const items = [
		...(await humanWriters(located, login, isWriter)).map(reviewCommentItem),
		...(await humanWriters(comments, login, isWriter)).map((c) => commentItem(pr, c)),
		...(await humanWriters(withBody, login, isWriter)).map((r) => reviewItem(pr, r)),
		...failingChecks(checks.checks).map((c) => checkItem(pushedHead, c)),
	];
	return items.filter((i) => !ingested.has(i.key));
}
