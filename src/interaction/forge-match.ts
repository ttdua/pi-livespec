// Matching plain `/livespec …` command comments to requests (design D4), pure.
// A command's target is fixed by its position in the thread: only requests
// posted before it and not yet answered at that point count, so a command that
// is ignored once (for example as ambiguous) stays ignored in every later poll.

import type { MarkedComment } from "../forge/markers.ts";
import type { Comment } from "../forge/types.ts";
import type { Answered, Override, QuestionClass } from "./approver.ts";
import { type Command, parseCommand } from "./commands.ts";
import { allRequests, type Closer, closers, type PendingRequest } from "./requests.ts";
import { failingWaivableOf, unwaivedApproval } from "./waive-rule.ts";

export type Permission = "none" | "read" | "write" | "admin";

/** One pending request answered by a command comment. */
export type CommandMatch = { request: PendingRequest; answer: Answered };

/** A `/livespec class` command for a question with a pending request. */
export type ClassChange = { question: string; class: QuestionClass; commentId: string };

export type MatchResult = { matches: CommandMatch[]; classes: ClassChange[]; warnings: string[] };

export type MatchOptions = {
	/**
	 * The own marked comments of the thread. They give every request (pending, applying or completed)
	 * and the comment that closed it, so targets are computed per command position.
	 */
	marked: MarkedComment[];
	/** Ids of command comments whose `/livespec class` was applied and recorded; they are skipped silently. */
	appliedClasses?: ReadonlySet<string>;
};

const WRITERS = new Set<Permission>(["write", "admin"]);
/** Warning lines kept per pass; the rest are counted in one "+k more" line. */
const MAX_WARNINGS = 5;
const GATE_LIKE = ["gate:", "amend:"];
const CHOICE_LIKE = ["stuck:", "decide:"];

const hasPrefix = (subject: string, prefixes: string[]): boolean => prefixes.some((p) => subject.startsWith(p));
const isGateLike = (r: PendingRequest): boolean => hasPrefix(r.subject, GATE_LIKE);
const isChoiceLike = (r: PendingRequest): boolean => hasPrefix(r.subject, CHOICE_LIKE);

// --- positions -----------------------------------------------------------------------

/** A request with where it sits in the thread and the index of the comment that closed it, if any. */
type Placed = { request: PendingRequest; at: number; closedAt: number; closer?: Closer };

function indexById(comments: Comment[]): Map<string, number> {
	return new Map(comments.map((c, i) => [c.id, i]));
}

function place(comments: Comment[], marked: MarkedComment[]): Placed[] {
	const index = indexById(comments);
	const closed = closers(marked);
	return allRequests(marked).map(({ commentId, ...request }) => {
		const closer = closed.get(request.id);
		const placed: Placed = { request, at: index.get(commentId) ?? -1, closedAt: closer ? (index.get(closer.commentId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY };
		if (closer) placed.closer = closer;
		return placed;
	});
}

/** Whether `comment` (at `index`) was created after the request was posted. */
function createdAfter(p: Placed, comment: Comment, index: number): boolean {
	if (p.at !== -1) return index > p.at;
	return p.request.createdAt !== "" && comment.createdAt > p.request.createdAt;
}

// --- targets -------------------------------------------------------------------------

type Target = { request: PendingRequest } | { warning: string };

function single(candidates: PendingRequest[], what: string): Target | undefined {
	if (candidates.length === 1) return { request: candidates[0] as PendingRequest };
	if (candidates.length > 1) return { warning: `ambiguous between ${candidates.map((r) => r.subject).join(", ")} (${what})` };
	return undefined;
}

/** approve, changes and choose: the single gate-like request, else the single stuck or decide request. */
function decisionTarget(open: PendingRequest[]): Target {
	return (
		single(open.filter(isGateLike), "pending gate or amendment requests") ??
		single(open.filter(isChoiceLike), "pending stuck or decide requests") ?? { warning: "no pending request it can answer" }
	);
}

/** dismiss: like approve, then the single pending question request. */
function dismissTarget(open: PendingRequest[]): Target {
	const target = decisionTarget(open);
	if ("request" in target || !target.warning.startsWith("no pending")) return target;
	return single(open.filter((r) => r.subject.startsWith("question:")), "pending question requests") ?? target;
}

function questionTarget(open: PendingRequest[], question: string): Target {
	const r = open.find((p) => p.subject === `question:${question}`);
	return r ? { request: r } : { warning: `no pending request for ${question}` };
}

function setTarget(open: PendingRequest[]): Target {
	const candidates = open.filter((r) => r.subject === "gate:plan" || r.subject.startsWith("amend:"));
	return single(candidates, "pending plan or amendment requests") ?? { warning: "no pending plan or amendment request" };
}

function targetOf(open: PendingRequest[], command: Command): Target {
	switch (command.verb) {
		case "approve":
		case "changes":
		case "choose":
			return decisionTarget(open);
		case "dismiss":
			return dismissTarget(open);
		case "answer":
		case "class":
			return questionTarget(open, command.question);
		case "set":
			return setTarget(open);
	}
}

// --- answers -------------------------------------------------------------------------

function base(comment: Comment): Pick<Answered, "status" | "by" | "at" | "adapter" | "answerComment"> {
	return {
		status: "answered",
		by: comment.author,
		at: comment.createdAt,
		adapter: "forge",
		answerComment: { id: comment.id, author: comment.author, updatedAt: comment.updatedAt },
	};
}

/** The answer a command gives, or why it cannot answer `request`; an unwaived approval is refused here too. */
function decisionAnswer(request: PendingRequest, command: Command, comment: Comment): Answered | string {
	const answer = commandAnswer(request, command, comment);
	if (typeof answer === "string") return answer;
	return unwaivedApproval(failingWaivableOf(request.data.snapshot), answer) ?? answer;
}

function commandAnswer(request: PendingRequest, command: Command, comment: Comment): Answered | string {
	const answer = base(comment);
	switch (command.verb) {
		case "approve": {
			if (isChoiceLike(request)) return `approve cannot answer ${request.subject}: use /livespec choose <option-id>`;
			return { ...answer, outcome: command.notes === "" ? "approved" : "approved_with_notes", notes: command.notes };
		}
		case "changes":
			if (isChoiceLike(request)) return `changes cannot answer ${request.subject}: use /livespec choose <option-id>`;
			return { ...answer, outcome: "changes_requested", notes: command.notes };
		case "dismiss":
			return { ...answer, outcome: "dismissed", notes: command.notes };
		case "choose": {
			const options = request.data.options ?? [];
			if (!options.some((o) => o.id === command.option)) return `option ${command.option} is not offered by ${request.subject}`;
			return { ...answer, outcome: command.notes === "" ? "approved" : "approved_with_notes", notes: command.notes, choice: command.option };
		}
		case "answer": {
			const a: Answered = { ...answer, outcome: "approved", notes: "", answer: command.text };
			if (command.changes !== undefined) a.changesRequirement = command.changes;
			if (command.class !== undefined) a.questionClass = command.class;
			return a;
		}
		default:
			return `${command.verb} does not answer a request`;
	}
}

// --- the pass ------------------------------------------------------------------------

type Ctx = {
	placed: Placed[];
	/** Comments at or before this index are matched for state but never warned (see `warnFrom`). */
	warnAfter: number;
	pendingIds: ReadonlySet<string>;
	perms: ReadonlyMap<string, Permission>;
	/** Command comments recorded answers used; they are skipped silently. */
	consumed: ReadonlySet<string>;
	/** Command comments whose `/livespec class` was already applied. */
	appliedClasses: ReadonlySet<string>;
	/** Request id → the command comment that answered it in this pass. */
	answered: Map<string, string>;
	overrides: Map<string, Map<string, Override>>;
	result: MatchResult;
	/** Every warning of the pass, before the cap. */
	warnings: string[];
};

function warn(ctx: Ctx, comment: Comment, index: number, reason: string): void {
	if (index > ctx.warnAfter) ctx.warnings.push(`ignored /livespec comment ${comment.id} by ${comment.author}: ${reason}`);
}

/** The first `MAX_WARNINGS` warnings, then one line counting the rest. */
function capped(warnings: string[]): string[] {
	if (warnings.length <= MAX_WARNINGS) return warnings;
	return [...warnings.slice(0, MAX_WARNINGS), `+${warnings.length - MAX_WARNINGS} more ignored /livespec comments`];
}

/**
 * Where warnings start: after the comment that closed the latest closed request (its answer or result)
 * that precedes the earliest pending request, or the thread start when none does. A command after that
 * point (for example one posted just before the pending request) is warned; commands before an already
 * closed request are history and stay silent, so they are not re-warned on every poll. -1 warns every
 * command, also when a pending request's comment is not in the thread.
 */
function warnAfterOf(placed: Placed[], pendingIds: ReadonlySet<string>): number {
	const found = placed.filter((p) => pendingIds.has(p.request.id)).map((p) => p.at);
	if (found.length !== pendingIds.size || found.length === 0 || found.includes(-1)) return -1;
	const earliest = Math.min(...found);
	const closedBefore = placed.map((p) => p.closedAt).filter((i) => i < earliest);
	return closedBefore.length === 0 ? -1 : Math.max(...closedBefore);
}

/** Requests open at `index`: posted before the comment and not closed before it. */
function openAt(ctx: Ctx, comment: Comment, index: number): PendingRequest[] {
	return ctx.placed.filter((p) => p.closedAt > index && createdAfter(p, comment, index)).map((p) => p.request);
}

/** When the command targets nothing open at its position but would target a later request, name it. */
function beforeRequest(ctx: Ctx, command: Command, index: number): string | undefined {
	const later = targetOf(ctx.placed.filter((p) => p.closedAt > index).map((p) => p.request), command);
	return "request" in later ? `it was created before the request ${later.request.id}` : undefined;
}

/** Why the target cannot take this command any more because another comment answered it first. */
function answeredBy(ctx: Ctx, request: PendingRequest): string | undefined {
	const inPass = ctx.answered.get(request.id);
	if (inPass !== undefined) return inPass;
	const closer = ctx.placed.find((p) => p.request.id === request.id)?.closer;
	return closer ? (closer.answerCommentId ?? closer.commentId) : undefined;
}

/**
 * Whether `set` may override `unit` on `request`: an amendment only its own unit, and nothing for a drop
 * (the units `amendRequest` marks overridable); the plan gate any unit.
 */
function overridable(request: PendingRequest, unit: string): boolean {
	if (!request.subject.startsWith("amend:")) return true;
	const s = request.data.snapshot as { action?: unknown; unit?: unknown };
	return s.action !== "drop" && s.unit === unit;
}

function recordSet(ctx: Ctx, request: PendingRequest, command: Extract<Command, { verb: "set" }>): void {
	const byUnit = ctx.overrides.get(request.id) ?? new Map<string, Override>();
	const current = byUnit.get(command.unit) ?? { unit: command.unit };
	byUnit.set(command.unit, command.field === "difficulty" ? { ...current, difficulty: command.value } : { ...current, tags: command.value });
	ctx.overrides.set(request.id, byUnit);
}

function withOverrides(ctx: Ctx, request: PendingRequest, answer: Answered): Answered {
	const overrides = ctx.overrides.get(request.id);
	return overrides && overrides.size > 0 ? { ...answer, overrides: [...overrides.values()] } : answer;
}

function apply(ctx: Ctx, comment: Comment, index: number, request: PendingRequest, command: Command): void {
	if (command.verb === "set") {
		if (!overridable(request, command.unit)) return warn(ctx, comment, index, `${command.unit} is not in ${request.subject}, so it cannot be set`);
		return recordSet(ctx, request, command);
	}
	if (command.verb === "class") {
		ctx.result.classes.push({ question: command.question, class: command.class, commentId: comment.id });
		return;
	}
	const answer = decisionAnswer(request, command, comment);
	if (typeof answer === "string") return warn(ctx, comment, index, answer);
	ctx.answered.set(request.id, comment.id);
	if (ctx.pendingIds.has(request.id)) ctx.result.matches.push({ request, answer: withOverrides(ctx, request, answer) });
}

/**
 * The target is resolved before the permission check: only a command that would act on a pending request
 * needs its author's permission, and `perms` covers only authors after the earliest pending request.
 */
function matchOne(ctx: Ctx, comment: Comment, index: number): void {
	const parsed = parseCommand(comment.body);
	if (parsed === undefined || ctx.consumed.has(comment.id)) return;
	if ("error" in parsed) return warn(ctx, comment, index, `cannot be parsed (${parsed.error})`);
	if (parsed.verb === "class" && ctx.appliedClasses.has(comment.id)) return;
	const target = targetOf(openAt(ctx, comment, index), parsed);
	if ("warning" in target) return warn(ctx, comment, index, beforeRequest(ctx, parsed, index) ?? target.warning);
	const first = parsed.verb === "set" || parsed.verb === "class" ? undefined : answeredBy(ctx, target.request);
	if (first !== undefined) return warn(ctx, comment, index, `${target.request.subject} was already answered by ${first}`);
	if (!ctx.pendingIds.has(target.request.id)) return;
	if (!WRITERS.has(ctx.perms.get(comment.author) ?? "none")) return warn(ctx, comment, index, "its author lacks write access");
	apply(ctx, comment, index, target.request, parsed);
}

function consumedIds(placed: Placed[]): Set<string> {
	return new Set(placed.flatMap((p) => (p.closer?.answerCommentId === undefined ? [] : [p.closer.answerCommentId])));
}

/**
 * Matches plain command comments to requests (design D4), in comment order. Each command targets the
 * requests open at its position; the first valid answer per request wins and later ones are warned.
 * Only answers to `pending` requests are returned. `perms` holds `getPermission` per author.
 *
 * Warnings: a command is warned for its target (unparsable, no or ambiguous target, created before its
 * request, already answered) before its author's permission is checked, so a target warning wins. A
 * command whose target is not pending any more (an applying or completed request, including any `set` or
 * `class`) is skipped silently. Only commands after the latest request closed before the earliest pending
 * one are warned (see `warnAfterOf`), and the list is capped at five lines plus "+k more".
 */
export function matchCommands(
	pending: PendingRequest[],
	comments: Comment[],
	perms: ReadonlyMap<string, Permission>,
	opts: MatchOptions,
): MatchResult {
	const placed = place(comments, opts.marked);
	const pendingIds = new Set(pending.map((p) => p.id));
	const ctx: Ctx = {
		placed,
		warnAfter: warnAfterOf(placed, pendingIds),
		pendingIds,
		perms,
		consumed: consumedIds(placed),
		appliedClasses: opts.appliedClasses ?? new Set(),
		answered: new Map(),
		overrides: new Map(),
		result: { matches: [], classes: [], warnings: [] },
		warnings: [],
	};
	comments.forEach((comment, index) => matchOne(ctx, comment, index));
	ctx.result.warnings = capped(ctx.warnings);
	return ctx.result;
}
