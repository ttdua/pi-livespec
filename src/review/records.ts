// Review records: the `review-run` marker kind, the aggregate and verifier `finding-summary` shapes, and their queries.

import { type MarkedComment, registerKind, writeMarked } from "../forge/markers.ts";
import type { AppendInput } from "../ledger/entry.ts";
import { type AggregateFinding, current, type FindingSummaryData } from "../subagents/records.ts";
import { isFindingData } from "../subagents/validate.ts";
import type { Finding, ReviewSubject } from "../subagents/roles.ts";

const RUN_KIND = "review-run";
registerKind(RUN_KIND);

export type VerifyRun = { exit: number | null; verdict: "green" | "red" | "invalid" };

export type ReviewRunData = {
	round: number;
	head: string;
	selected: ReviewSubject[];
	tags: string[];
	verify: Record<string, VerifyRun>;
	parentFindings: Finding[];
	routed: boolean;
	prComments?: string[];
	/** `pull-request` for a feedback round: nothing selected, aggregated and routed at its own `head`. */
	source?: "pull-request";
	/** Keys of the pull request feedback this round ingested. */
	feedbackKeys?: string[];
};

/** The parent writes the aggregate itself: no child, packet or launch facts. */
const PARENT_SOURCE = "livespec";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrList = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");

function isRunData(d: unknown): d is ReviewRunData {
	return (
		isObj(d) && typeof d.round === "number" && Number.isInteger(d.round) && typeof d.head === "string" && isStrList(d.selected) &&
		isStrList(d.tags) && isObj(d.verify) && Array.isArray(d.parentFindings) && d.parentFindings.every(isFindingData) && typeof d.routed === "boolean" &&
		(d.prComments === undefined || isStrList(d.prComments)) && (d.source === undefined || d.source === "pull-request") &&
		(d.feedbackKeys === undefined || isStrList(d.feedbackKeys))
	);
}

/** One comment per round id; the route stage posts the same id again with `routed: true`. */
export function reviewRunComment(data: ReviewRunData): string {
	return writeMarked(RUN_KIND, `${RUN_KIND}.${data.round}`, data);
}

export const aggregateId = (round: number): string => `finding-summary.change.review.${round}`;

export function aggregateComment(data: { round: number; head: string; reviews: string[]; findings: AggregateFinding[] }): AppendInput {
	const summary: FindingSummaryData = {
		role: "reviewer", subject: "change", round: data.round, status: "DONE", advisory: false, head: data.head, packet: "", sources_used: [], required: [],
		completed: true, agentSource: PARENT_SOURCE, findings: data.findings, aggregate: true, reviews: data.reviews,
		// Placeholders: `FindingSummaryData` and `isSummaryData` require launch facts, but a parent-made record launched no child.
		requested: { thinking: "low" },
		effective: {},
	};
	return { kind: "finding-summary", id: aggregateId(data.round), data: summary };
}

/** Valid `review-run` records, the latest comment of each id only, in comment order. */
function runs(marked: MarkedComment[]): (ReviewRunData & { commentId: string })[] {
	const latest = new Map<string, MarkedComment>();
	for (const m of marked) {
		if (m.kind !== RUN_KIND || !isRunData(m.data)) continue;
		latest.delete(m.id);
		latest.set(m.id, m);
	}
	return [...latest.values()].map((m) => ({ ...(m.data as ReviewRunData), commentId: m.ref }));
}

/** The most recently written round's `review-run` record. */
export function latestRun(marked: MarkedComment[]): (ReviewRunData & { commentId: string }) | undefined {
	return runs(marked).at(-1);
}

/** The latest round, when it was started at `head`. */
export function runAtHead(marked: MarkedComment[], head: string): ReviewRunData | undefined {
	const run = latestRun(marked);
	if (run === undefined || run.head !== head) return undefined;
	const { commentId: _, ...data } = run;
	return data;
}

/** Valid, current aggregate records with their comment index, in comment order. */
export function aggregates(marked: MarkedComment[]): { commentId: string; at: number; data: FindingSummaryData }[] {
	const kept = new Set(current(marked));
	return marked.flatMap((m, at) => (kept.has(m) && m.kind === "finding-summary" && (m.data as FindingSummaryData).aggregate === true ? [{ commentId: m.ref, at, data: m.data as FindingSummaryData }] : []));
}

/** The aggregate record of `round`; its single findings are read through `aggregateFinding`. */
export function aggregateOf(marked: MarkedComment[], round: number): { commentId: string; data: FindingSummaryData } | undefined {
	const found = aggregates(marked).filter((a) => a.data.round === round).at(-1);
	return found === undefined ? undefined : { commentId: found.commentId, data: found.data };
}

/** A run that decides the verdict: completed, or `BLOCKED` (fail closed). Any other incomplete run is dispatched again. */
const decides = (d: FindingSummaryData): boolean => d.completed || d.status === "BLOCKED";

/** The latest completed or `BLOCKED` verifier record of the aggregate finding `key` (`<aggregateCommentId>:<index>`). */
export function verifierRecord(marked: MarkedComment[], key: string): FindingSummaryData | undefined {
	return current(marked)
		.map((m) => (m.kind === "finding-summary" ? (m.data as FindingSummaryData) : undefined))
		.filter((d): d is FindingSummaryData => d !== undefined && d.role === "verifier" && d.verifies === key && decides(d))
		.at(-1);
}
