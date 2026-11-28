// Shared, single-purpose effect helpers of the completion engine (design D2).
// A `Run` keeps the own marked comments seen so far plus every comment this run
// wrote, so each effect can tell whether it is already applied.

import { parseChange } from "../core/change.ts";
import type { Git } from "../engine/git.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState, PhaseState } from "../engine/state-types.ts";
import { phaseFromLabels } from "../engine/snapshot.ts";
import { type MarkedComment, parseMarked } from "../forge/markers.ts";
import type { Forge, Issue } from "../forge/types.ts";
import type { AppendInput } from "../ledger/entry.ts";
import type { Ledger } from "../ledger/index.ts";
import { lastForgeRef } from "../ledger/merge.ts";
import type { ShipContext, ShipInput } from "../ship/context.ts";
import type { AnswerData } from "./requests.ts";

/** What completion needs; `root` is the repository root the checks read specs from. */
export type CompletionCtx = {
	forge: Forge;
	ledger: Ledger;
	git: Git;
	pack: Pack;
	issue: number;
	marked: MarkedComment[];
	root: string;
	/** The ship context for a change state (`shipFor`): built in `ship` only. Without it, validation passes no ship context. */
	shipFor?: (state: ShipInput & Pick<ChangeState, "phase">) => Promise<ShipContext | { refused: string } | undefined>;
	agentSkills?: string;
	now: () => Date;
};

/** One completion run: the context plus the own marked comments, kept current as the run writes. */
export type Run = { ctx: CompletionCtx; marked: MarkedComment[] };

/** The result of an apply module, written last by the dispatcher: a forge comment body or a ledger entry. */
export type ResultRecord = { comment: string } | { entry: AppendInput };

export type ApplyFn = (run: Run, record: AnswerData) => Promise<ResultRecord>;

export function startRun(ctx: CompletionCtx): Run {
	return { ctx, marked: [...ctx.marked] };
}

/** Posts an own comment and remembers it when it is marked. */
export async function postComment(run: Run, body: string): Promise<void> {
	const comment = await run.ctx.forge.createComment(run.ctx.issue, body);
	const parsed = parseMarked(comment.body);
	if (parsed) run.marked.push({ ref: comment.id, source: "forge", author: comment.author, createdAt: comment.createdAt, ...parsed });
}

/** Appends `input` to the ledger after the last forge record and remembers the merged record. */
export async function appendRecord(run: Run, input: AppendInput): Promise<void> {
	const after = lastForgeRef(run.marked);
	const entry = await run.ctx.ledger.append(run.ctx.issue, { ...input, ...(after === undefined ? {} : { after }) });
	run.marked.push({ ref: entry.ref, source: "ledger", kind: entry.kind, id: entry.id, author: "", data: entry.data, createdAt: entry.at, ...(entry.from === undefined ? {} : { from: entry.from }) });
}

/** Writes an apply module's result: the comment is posted, the entry appended. */
export function writeResult(run: Run, result: ResultRecord): Promise<void> {
	return "comment" in result ? postComment(run, result.comment) : appendRecord(run, result.entry);
}

/** True when an own marked comment of `kind` with `id` exists (and, when given, carries `request`). */
export function hasMarked(run: Run, kind: string, id: string, request?: string): boolean {
	return run.marked.some((m) => m.kind === kind && m.id === id && (request === undefined || requestOf(m.data) === request));
}

function requestOf(data: unknown): unknown {
	return typeof data === "object" && data !== null ? (data as { request?: unknown }).request : undefined;
}

/** Posts `body` unless a comment of `kind`/`id` (for `request`, when given) already exists. */
export async function postOnce(run: Run, kind: string, id: string, body: string, request?: string): Promise<void> {
	if (!hasMarked(run, kind, id, request)) await postComment(run, body);
}

export function readIssue(run: Run): Promise<Issue> {
	return run.ctx.forge.getIssue(run.ctx.issue);
}

/**
 * Writes `edit(body)` with a version check; skipped when the body already holds that text. A conflict
 * throws, so the request stays applying and the next poll retries.
 */
export async function editBody(run: Run, edit: (body: string) => string): Promise<void> {
	const issue = await readIssue(run);
	const next = edit(issue.body);
	if (next === issue.body) return;
	const written = await run.ctx.forge.updateIssueBody(run.ctx.issue, next, issue.version);
	if (written.status === "conflict") throw new Error(`the issue body changed during completion (${written.changed.join(", ")}); retry`);
}

/** The phase labels of the issue: one id, several (a half-done move), or none. */
export async function currentPhase(run: Run): Promise<PhaseState> {
	return phaseFromLabels((await readIssue(run)).labels);
}

/** Every phase reachable forward from `phase` through `requires`, in pack order. */
export function phasesAfter(pack: Pack, phase: string): string[] {
	const after = new Set<string>();
	let grew = true;
	while (grew) {
		grew = false;
		for (const p of pack.phases) {
			if (after.has(p.id)) continue;
			if (p.requires.some((r) => r === phase || after.has(r))) {
				after.add(p.id);
				grew = true;
			}
		}
	}
	return pack.phases.map((p) => p.id).filter((id) => after.has(id));
}

export async function currentChange(run: Run) {
	return parseChange((await readIssue(run)).body);
}
