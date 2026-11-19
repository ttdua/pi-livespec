// Reads the facts of one change from the forge (issue, own marked comments)
// and git into a plain ChangeState, without checks. Nothing here is a source
// of truth: every call rebuilds the state.

import { type Change, parseChange } from "../core/change.ts";
import { sectionText } from "../core/sections.ts";
import { isOffline } from "../forge/errors.ts";
import { phaseLabel } from "../forge/labels.ts";
import { filterMarked, type MarkedComment } from "../forge/markers.ts";
import type { Forge, Issue } from "../forge/types.ts";
import { readRequests } from "../interaction/requests.ts";
import { findExecutor } from "../subagents/executor.ts";
import { invalidRecords, pendingQuestion } from "../subagents/records.ts";
import { invalidLanes, openLanes } from "../subagents/state.ts";
import type { CommentsCache } from "./comments-cache.ts";
import { deriveUnitEvidence } from "../evidence/unit-state.ts";
import { readCounters } from "./counters.ts";
import { type Git, GitError } from "./git.ts";
import { deriveIterations } from "./iterations.ts";
import { deriveLocks } from "./locks.ts";
import type { ChangeState, PhaseState, SectionName } from "./state-types.ts";

/** The pack's `loops.change_iterations` and `loops.unit_attempts`; a missing cap never blocks. */
export type Caps = { iterations: number | undefined; unitAttempts: number | undefined };

export type SnapshotDeps = { forge: Forge; isReadOnly(): boolean; git: Git; comments: CommentsCache; caps?: { iterations?: number; unitAttempts?: number } };

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

/**
 * The login confirmed by `whoami` now, or undefined when the forge is unreachable. A login seen
 * earlier is never reused: the account may have switched, and its state must not be counted.
 */
async function currentLogin(forge: Forge): Promise<string | undefined> {
	try {
		return (await forge.whoami()).login;
	} catch (error) {
		if (isOffline(error)) return undefined;
		throw error;
	}
}

type DerivedFacts = Pick<ChangeState, "counters" | "skillNotes" | "incomplete" | "marked" | "requests" | "lock" | "iterations" | "evidence" | "subagents">;

type CommentFacts = DerivedFacts & { stale: boolean; warnings: string[] };

const invalidWarnings = (marked: MarkedComment[]): string[] => [...invalidRecords(marked), ...invalidLanes(marked)];

const UNKNOWN_LOGIN_WARNING = "the forge is unreachable and the current login is unknown: own marked comments are not read";

/** Pure: every fact derived from the own marked comments and the parsed body. */
export function deriveCommentFacts(
	marked: MarkedComment[],
	change: Change,
	caps: Caps,
): DerivedFacts {
	const iterations = deriveIterations(marked, caps.iterations);
	const evidence = deriveUnitEvidence(change, marked, caps.unitAttempts);
	return {
		counters: { ...readCounters(marked), ...attemptCounters(evidence.attempts), change_iterations: iterations.count },
		skillNotes: idsOfKind(marked, "skill-note"),
		incomplete: incompleteItems(marked),
		evidence,
		marked,
		requests: readRequests(marked),
		lock: deriveLocks(change, marked),
		iterations,
		subagents: deriveSubagents(marked),
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

async function readCommentFacts(d: SnapshotDeps, issue: Issue, change: Change): Promise<CommentFacts> {
	const read = await d.comments.list(d.forge, issue);
	const login = await currentLogin(d.forge);
	const own = login === undefined ? { comments: [], warnings: [UNKNOWN_LOGIN_WARNING] } : filterMarked(read.comments, login);
	return {
		...deriveCommentFacts(own.comments, change, { iterations: d.caps?.iterations, unitAttempts: d.caps?.unitAttempts }),
		stale: read.stale || login === undefined,
		warnings: [...own.warnings, ...invalidWarnings(own.comments)],
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
	return {
		issue: { number: issue.number, title: issue.title, labels: [...issue.labels], ...(issue.url === undefined ? {} : { url: issue.url }) },
		phase: phaseFromLabels(issue.labels),
		change,
		sections: sectionPresence(issue.body, change),
		counters: comments.counters,
		skillNotes: comments.skillNotes,
		incomplete: comments.incomplete,
		git: git.git,
		stale: issue.stale === true || comments.stale,
		readOnly: d.isReadOnly(),
		warnings: [...comments.warnings, ...git.warnings],
		marked: comments.marked,
		requests: comments.requests,
		lock: comments.lock,
		iterations: comments.iterations,
		commandWarnings: [],
		evidence: comments.evidence,
		subagents: comments.subagents,
	};
}
