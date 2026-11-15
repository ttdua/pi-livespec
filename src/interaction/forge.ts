// The forge adapter (design D2, D4): a request is an own marked `request`
// comment with plain-text instructions; answers are plain `/livespec …`
// command comments from writers, matched purely by `matchCommands`.

import { filterMarked, parseMarked, readMarkedComments } from "../forge/markers.ts";
import type { Comment, Forge } from "../forge/types.ts";
import type { Answered, ApprovalRequest, Approver, Override, QuestionClass } from "./approver.ts";
import { ANSWER_KIND, REQUEST_KIND } from "./approver.ts";
import { type Command, parseCommand } from "./commands.ts";
import { type PendingRequest, readRequests, requestComment } from "./requests.ts";

export type Permission = "none" | "read" | "write" | "admin";

/** One pending request answered by a command comment. */
export type CommandMatch = { request: PendingRequest; answer: Answered };

/** A `/livespec class` command for a question with a pending request. */
export type ClassChange = { question: string; class: QuestionClass };

export type MatchResult = { matches: CommandMatch[]; classes: ClassChange[]; warnings: string[] };

export type MatchOptions = {
	/** Ids of command comments a recorded answer already used; they are skipped silently. */
	consumed?: ReadonlySet<string>;
};

/** Thrown by `request` when a request for the same subject is already pending. */
export class DuplicateRequestError extends Error {
	constructor(readonly pendingId: string, subject: string) {
		super(`A request for ${subject} is pending (${pendingId}): wait for its answer or end it with /livespec dismiss.`);
		this.name = "DuplicateRequestError";
	}
}

const PREFIX = "/livespec ";
const WRITERS = new Set<Permission>(["write", "admin"]);
const GATE_LIKE = ["gate:", "amend:"];
const CHOICE_LIKE = ["stuck:", "decide:"];
const WAIVE = "waive";

const hasPrefix = (subject: string, prefixes: string[]): boolean => prefixes.some((p) => subject.startsWith(p));
const isGateLike = (r: PendingRequest): boolean => hasPrefix(r.subject, GATE_LIKE);
const isChoiceLike = (r: PendingRequest): boolean => hasPrefix(r.subject, CHOICE_LIKE);

// --- plain-text instructions (design D4) ------------------------------------------

function commandsFor(r: ApprovalRequest): string[] {
	if (r.kind === "question") {
		const id = r.question?.id ?? r.subject.slice("question:".length);
		return [
			`/livespec answer ${id} <text> [--changes <capability>/Requirement: <name>] [--class blocking|non-blocking]`,
			`/livespec class ${id} blocking|non-blocking`,
			"/livespec dismiss [notes]",
		];
	}
	if (r.kind === "stuck" || r.subject.startsWith("decide:")) return ["/livespec choose <option-id> [notes]", "/livespec dismiss [notes]"];
	const lines = ["/livespec approve [notes]", "/livespec changes <notes>", "/livespec dismiss [notes]"];
	if ((r.options ?? []).length > 0) lines.push("/livespec choose <option-id> [notes]");
	if (r.overridable) lines.push("/livespec set U<n> difficulty <low|medium|high>", "/livespec set U<n> tags <a,b,…>");
	return lines;
}

/** What is asked, the review payload and the accepted commands; the parser ignores this text. */
export function plainText(r: ApprovalRequest): string {
	const out = [`**livespec asks for ${r.subject}** (${r.mode}):`, "", r.summary];
	if (r.options && r.options.length > 0) out.push("", "Options:", ...r.options.map((o) => `- \`${o.id}\`: ${o.label}`));
	if (r.links.length > 0) out.push("", "Links:", ...r.links.map((l) => `- ${l}`));
	if (r.files.length > 0) out.push("", "Files:", ...r.files.map((f) => `- ${f}`));
	out.push(
		"",
		"Answer with a new comment whose first line is one of these commands (write access required):",
		...commandsFor(r).map((c) => `- \`${c}\``),
	);
	return out.join("\n");
}

// --- matching (pure) -----------------------------------------------------------------

type Ctx = {
	pending: PendingRequest[];
	comments: Comment[];
	perms: ReadonlyMap<string, Permission>;
	consumed: ReadonlySet<string>;
	answered: Set<string>;
	overrides: Map<string, Map<string, Override>>;
	result: MatchResult;
};

/** Position of the request's own comment in `comments`, or -1 when it is not there. */
function requestIndex(comments: Comment[], id: string): number {
	return comments.findIndex((c) => {
		const m = parseMarked(c.body);
		return m?.kind === REQUEST_KIND && m.id === id;
	});
}

/** Whether `comment` (at `index`) was created after the request was posted. */
function createdAfter(ctx: Ctx, request: PendingRequest, comment: Comment, index: number): boolean {
	const at = requestIndex(ctx.comments, request.id);
	if (at !== -1) return index > at;
	return request.createdAt !== "" && comment.createdAt > request.createdAt;
}

type Target = { request: PendingRequest } | { warning: string };

function single(candidates: PendingRequest[], what: string): Target | undefined {
	if (candidates.length === 1) return { request: candidates[0] as PendingRequest };
	if (candidates.length > 1) return { warning: `ambiguous between ${candidates.map((r) => r.subject).join(", ")} (${what})` };
	return undefined;
}

/** approve, changes and choose: the single gate-like request, else the single stuck or decide request. */
function decisionTarget(pending: PendingRequest[]): Target {
	return (
		single(pending.filter(isGateLike), "pending gate or amendment requests") ??
		single(pending.filter(isChoiceLike), "pending stuck or decide requests") ?? { warning: "no pending request it can answer" }
	);
}

/** dismiss: like approve, then the single pending question request. */
function dismissTarget(pending: PendingRequest[]): Target {
	const target = decisionTarget(pending);
	if ("request" in target || !target.warning.startsWith("no pending")) return target;
	return single(pending.filter((r) => r.subject.startsWith("question:")), "pending question requests") ?? target;
}

function questionTarget(pending: PendingRequest[], question: string): Target {
	const r = pending.find((p) => p.subject === `question:${question}`);
	return r ? { request: r } : { warning: `no pending request for ${question}` };
}

function setTarget(pending: PendingRequest[]): Target {
	const candidates = pending.filter((r) => r.subject === "gate:plan" || r.subject.startsWith("amend:"));
	return single(candidates, "pending plan or amendment requests") ?? { warning: "no pending plan or amendment request" };
}

function targetOf(pending: PendingRequest[], command: Command): Target {
	switch (command.verb) {
		case "approve":
		case "changes":
		case "choose":
			return decisionTarget(pending);
		case "dismiss":
			return dismissTarget(pending);
		case "answer":
		case "class":
			return questionTarget(pending, command.question);
		case "set":
			return setTarget(pending);
	}
}

function failingWaivable(r: PendingRequest): string[] {
	const snapshot = r.data.snapshot as { failingWaivable?: unknown };
	return Array.isArray(snapshot.failingWaivable) ? snapshot.failingWaivable.map(String) : [];
}

function base(comment: Comment): Pick<Answered, "status" | "by" | "at" | "adapter" | "answerComment"> {
	return {
		status: "answered",
		by: comment.author,
		at: comment.createdAt,
		adapter: "forge",
		answerComment: { id: comment.id, author: comment.author, updatedAt: comment.updatedAt },
	};
}

/** The answer a decision command gives, or why it cannot answer `request`. */
function decisionAnswer(request: PendingRequest, command: Command, comment: Comment): Answered | string {
	const answer = base(comment);
	switch (command.verb) {
		case "approve": {
			if (isChoiceLike(request)) return `approve cannot answer ${request.subject}: use /livespec choose <option-id>`;
			const failing = failingWaivable(request);
			if (failing.length > 0) return `waivable checks fail (${failing.join(", ")}): they must be waived with /livespec choose ${WAIVE}`;
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

function warn(ctx: Ctx, comment: Comment, reason: string): void {
	ctx.result.warnings.push(`ignored /livespec comment ${comment.id} by ${comment.author}: ${reason}`);
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

function matchOne(ctx: Ctx, comment: Comment, index: number): void {
	const parsed = parseCommand(comment.body);
	if (parsed === undefined || ctx.consumed.has(comment.id)) return;
	if ("error" in parsed) return warn(ctx, comment, `cannot be parsed (${parsed.error})`);
	if (!WRITERS.has(ctx.perms.get(comment.author) ?? "none")) return warn(ctx, comment, "its author lacks write access");
	const target = targetOf(ctx.pending, parsed);
	if ("warning" in target) return warn(ctx, comment, target.warning);
	const { request } = target;
	if (ctx.answered.has(request.id)) return;
	if (!createdAfter(ctx, request, comment, index)) return warn(ctx, comment, `it was created before the request ${request.id}`);
	if (parsed.verb === "set") return recordSet(ctx, request, parsed);
	if (parsed.verb === "class") {
		ctx.result.classes.push({ question: parsed.question, class: parsed.class });
		return;
	}
	const answer = decisionAnswer(request, parsed, comment);
	if (typeof answer === "string") return warn(ctx, comment, answer);
	ctx.answered.add(request.id);
	ctx.result.matches.push({ request, answer: withOverrides(ctx, request, answer) });
}

/**
 * Matches plain command comments to pending requests (design D4), in comment order. The first valid
 * answer per request wins; later ones are ignored. `perms` holds `getPermission` per author.
 */
export function matchCommands(
	pending: PendingRequest[],
	comments: Comment[],
	perms: ReadonlyMap<string, Permission>,
	opts: MatchOptions = {},
): MatchResult {
	const ctx: Ctx = {
		pending,
		comments,
		perms,
		consumed: opts.consumed ?? new Set(),
		answered: new Set(),
		overrides: new Map(),
		result: { matches: [], classes: [], warnings: [] },
	};
	comments.forEach((comment, index) => matchOne(ctx, comment, index));
	return ctx.result;
}

/** Authors of comments whose first line starts with `/livespec `, each once, in order. */
export function commandAuthors(comments: Comment[]): string[] {
	return [...new Set(comments.filter((c) => c.body.startsWith(PREFIX)).map((c) => c.author))];
}

/** `getPermission` once per author. */
export async function readPermissions(forge: Pick<Forge, "getPermission">, authors: string[]): Promise<Map<string, Permission>> {
	const perms = new Map<string, Permission>();
	for (const author of authors) perms.set(author, await forge.getPermission(author));
	return perms;
}

/** Ids of command comments that recorded answers already used. */
export function consumedCommands(marked: { kind: string; data: unknown }[]): Set<string> {
	const ids = new Set<string>();
	for (const m of marked) {
		const d = m.data as { answer?: { answerComment?: { id?: unknown } }; answer_comment?: { id?: unknown } } | null;
		const id = m.kind === ANSWER_KIND ? d?.answer?.answerComment?.id : d?.answer_comment?.id;
		if (typeof id === "string") ids.add(id);
	}
	return ids;
}

// --- the adapter -------------------------------------------------------------------

export type ForgeApproverOptions = {
	/** Connected, writable and not blocked by the account; defaults to "not read-only" when the forge tells. */
	available?: () => boolean;
};

function defaultAvailable(forge: Forge): () => boolean {
	const readOnly = (forge as { isReadOnly?: () => boolean }).isReadOnly;
	return () => (typeof readOnly === "function" ? !readOnly.call(forge) : true);
}

export function createForgeApprover(forge: Forge, issue: number, opts: ForgeApproverOptions = {}): Approver {
	return {
		name: "forge",
		available: opts.available ?? defaultAvailable(forge),
		async request(r) {
			const { comments } = await readMarkedComments(forge, issue);
			const pending = readRequests(comments).pending.find((p) => p.subject === r.subject);
			if (pending) throw new DuplicateRequestError(pending.id, r.subject);
			await forge.createComment(issue, requestComment(r.record.id, r.record, plainText(r)));
			return { status: "pending", requestId: r.record.id };
		},
		async poll(requestId) {
			const [{ login }, comments] = await Promise.all([forge.whoami(), forge.listComments(issue)]);
			const marked = filterMarked(comments, login).comments;
			const answered = marked.find((m) => m.kind === ANSWER_KIND && m.id === requestId);
			if (answered) return (answered.data as { answer: Answered }).answer;
			const pending = readRequests(marked).pending.filter((p) => p.id === requestId);
			if (pending.length === 0) return { status: "pending" };
			const perms = await readPermissions(forge, commandAuthors(comments));
			const match = matchCommands(pending, comments, perms, { consumed: consumedCommands(marked) }).matches[0];
			return match ? match.answer : { status: "pending" };
		},
	};
}
