// Reads the facts of one change from the forge (issue, own marked comments)
// and git into a plain ChangeState, without checks. Nothing here is a source
// of truth: every call rebuilds the state.

import { type Change, parseChange } from "../core/change.ts";
import { sectionText } from "../core/sections.ts";
import { phaseLabel } from "../forge/labels.ts";
import type { MarkedComment } from "../forge/markers.ts";
import type { Forge, Issue } from "../forge/types.ts";
import type { FetchState, Ledger } from "../ledger/index.ts";
import { fetchWarnings, readOwnRecords } from "../ledger/records.ts";
import { readPullRequest } from "../ship/pull-request.ts";
import { readRequests } from "../interaction/requests.ts";
import { reviewRounds } from "../review/status.ts";
import { findExecutor } from "../subagents/executor.ts";
import { invalidRecords, pendingQuestion } from "../subagents/records.ts";
import { invalidLanes, openLanes } from "../subagents/state.ts";
import type { CommentsCache } from "./comments-cache.ts";
import { deriveUnitEvidence } from "../evidence/unit-state.ts";
import { readCounters } from "./counters.ts";
import { type Git, GitError } from "./git.ts";
import { discoveredDeps } from "./deps-facts.ts";
import { deriveIterations } from "./iterations.ts";
import { deriveLocks } from "./locks.ts";
import { parkedRecord } from "./parked.ts";
import type { ChangeState, PhaseState, SectionName } from "./state-types.ts";

/** The pack's `loops.change_iterations`, `loops.unit_attempts`, `loops.review_rounds` and `loops.discovered_deps`; a missing cap never blocks. */
export type Caps = { iterations: number | undefined; unitAttempts: number | undefined; reviewRounds: number | undefined; discoveredDeps?: number | undefined };

/** `fetch`: run the first ledger fetch of the session before reading (ledger-store "Ledger fetched before use"). */
export type SnapshotDeps = { forge: Forge; ledger: Ledger; fetch: boolean; isReadOnly(): boolean; git: Git; comments: CommentsCache; caps?: { iterations?: number; unitAttempts?: number; reviewRounds?: number; discoveredDeps?: number } };

const PHASE_PREFIX = phaseLabel("");
const BODY_SECTIONS = ["Proposal", "Design", "Units"] as const;
const SPECS_PATH = "specs/";

/** Phase ids from `livespec:phase/<id>` labels, in label order. */
export function phaseFromLabels(labels: string[]): PhaseState {
	const ids = labels.filter((l) => l.startsWith(PHASE_PREFIX)).map((l) => l.slice(PHASE_PREFIX.length));
	if (ids.length === 0) return { kind: "missing" };
	if (ids.length > 1) return { kind: "ambiguous", ids };
	return { kind: "ok", id: ids[0] as string };
}

/** `Capabilities` counts when the line declares at least one capability; H2 sections when non-empty. */
export function sectionPresence(body: string, change: Change): Record<SectionName, boolean> {
	const caps = change.header.capabilities;
	const presence: Record<SectionName, boolean> = {
		Capabilities: caps !== undefined && caps.new.length + caps.modified.length > 0,
		Proposal: false,
		Design: false,
		Units: false,
	};
	for (const name of BODY_SECTIONS) presence[name] = (sectionText(body, name)?.trim() ?? "") !== "";
	return presence;
}

function idsOfKind(marked: MarkedComment[], kind: string): string[] {
	return marked.filter((m) => m.kind === kind).map((m) => m.id);
}

/** The `items` of the latest own `incomplete` comment; empty when it is cleared, absent or malformed. */
function incompleteItems(marked: MarkedComment[]): string[] {
	const latest = marked.filter((m) => m.kind === "incomplete").at(-1);
	const items = (latest?.data as { items?: unknown } | null)?.items;
	return Array.isArray(items) ? items.filter((i): i is string => typeof i === "string") : [];
}

const attemptCounters = (attempts: Record<string, number>): Record<string, number> =>
	Object.fromEntries(Object.entries(attempts).map(([unit, n]) => [`unit_attempts.${unit}`, n]));

type DerivedFacts = Pick<ChangeState, "counters" | "skillNotes" | "incomplete" | "marked" | "requests" | "lock" | "iterations" | "evidence" | "subagents" | "parkedCore">;

type CommentFacts = DerivedFacts & { stale: boolean; warnings: string[]; fetchState?: FetchState };

const invalidWarnings = (marked: MarkedComment[]): string[] => [...invalidRecords(marked), ...invalidLanes(marked)];

/** Pure: every fact derived from the own marked comments and the parsed body. */
export function deriveCommentFacts(
	marked: MarkedComment[],
	change: Change,
	caps: Caps,
): DerivedFacts {
	const iterations = deriveIterations(marked, caps.iterations);
	const evidence = deriveUnitEvidence(change, marked, caps.unitAttempts);
	const parkedCore = parkedRecord(marked);
	return {
		counters: { ...readCounters(marked), ...attemptCounters(evidence.attempts), change_iterations: iterations.count, review_rounds: reviewRounds(marked, caps.reviewRounds).value, discovered_deps: discoveredDeps(marked, caps.discoveredDeps).value },
		skillNotes: idsOfKind(marked, "skill-note"),
		incomplete: incompleteItems(marked),
		evidence,
		marked,
		requests: readRequests(marked),
		lock: deriveLocks(change, marked),
		iterations,
		subagents: deriveSubagents(marked),
		...(parkedCore === undefined ? {} : { parkedCore }),
	};
}

/** Executor facts come from the live service; lanes and the pending question only from own comments. */
function deriveSubagents(marked: MarkedComment[]): ChangeState["subagents"] {
	const found = findExecutor();
	const pending = pendingQuestion(marked);
	return {
		executor: { ok: found.ok, missing: found.ok ? [] : found.missing },
		turnsCompleted: 0,
		lanes: openLanes(marked),
		unfamiliar: { change: false, units: {} },
		...(pending === undefined ? {} : { pending: { ...(pending.unit === undefined ? {} : { unit: pending.unit }), agentId: pending.agentId, question: pending.question } }),
	};
}

/** Own records from the cached comments and the local ledger, after the first fetch when `d.fetch`. */
async function readCommentFacts(d: SnapshotDeps, issue: Issue, change: Change): Promise<CommentFacts> {
	const fetchState = d.fetch ? await d.ledger.ensureFetched(issue.number) : undefined;
	const fetched = fetchState === undefined ? [] : fetchWarnings(fetchState, issue.number);
	const read = await d.comments.list(d.forge, issue);
	const own = await readOwnRecords(d.forge, d.ledger, issue.number, { comments: read.comments });
	return {
		...deriveCommentFacts(own.records, change, { iterations: d.caps?.iterations, unitAttempts: d.caps?.unitAttempts, reviewRounds: d.caps?.reviewRounds, discoveredDeps: d.caps?.discoveredDeps }),
		stale: read.stale || own.stale,
		warnings: [...fetched, ...own.warnings, ...invalidWarnings(own.records)],
		...(fetchState === undefined ? {} : { fetchState }),
	};
}

export type GitFacts = { git: ChangeState["git"]; warnings: string[] };

/** `specsChanged` is undefined without `Base`, and also (with a warning) when git cannot diff from it. */
export async function readGitFacts(git: Git, base: string | undefined): Promise<GitFacts> {
	const [branch, head, dirty] = await Promise.all([git.branch(), git.head(), git.isDirty()]);
	const warnings: string[] = [];
	let specsChanged: boolean | undefined;
	if (base !== undefined) {
		try {
			specsChanged = (await git.diff(base, "HEAD", SPECS_PATH)).trim() !== "";
		} catch (error) {
			if (!(error instanceof GitError)) throw error;
			warnings.push(`cannot diff specs/ from Base ${base}: ${error.stderr.trim() || error.message}`);
		}
	}
	return { git: { branch, head, dirty, specsChanged }, warnings };
}

export async function readChangeSnapshot(d: SnapshotDeps, n: number): Promise<Omit<ChangeState, "checks">> {
	const issue = await d.forge.getIssue(n);
	const change = parseChange(issue.body);
	const comments = await readCommentFacts(d, issue, change);
	const git = await readGitFacts(d.git, change.header.base);
	const pull = await readPullRequest(d.forge, d.git, change.header, change.header.branch, d.isReadOnly());
	return {
		issue: { number: issue.number, title: issue.title, labels: [...issue.labels], state: issue.state, ...(issue.url === undefined ? {} : { url: issue.url }) },
		phase: phaseFromLabels(issue.labels),
		change,
		sections: sectionPresence(issue.body, change),
		counters: comments.counters,
		skillNotes: comments.skillNotes,
		incomplete: comments.incomplete,
		git: git.git,
		...(pull.pr === undefined ? {} : { pr: pull.pr }),
		stale: issue.stale === true || comments.stale,
		readOnly: d.isReadOnly(),
		...(comments.fetchState === undefined ? {} : { fetchState: comments.fetchState }),
		warnings: [...comments.warnings, ...git.warnings, ...pull.warnings],
		marked: comments.marked,
		requests: comments.requests,
		lock: comments.lock,
		iterations: comments.iterations,
		commandWarnings: [],
		evidence: comments.evidence,
		subagents: comments.subagents,
		...(comments.parkedCore === undefined ? {} : { parkedCore: comments.parkedCore }),
	};
}
