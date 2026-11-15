// The forge adapter (design D2, D4): a request is an own marked `request`
// comment with plain-text instructions; answers are plain `/livespec …`
// command comments from writers, matched purely by `matchCommands`.

import { filterMarked, readMarkedComments } from "../forge/markers.ts";
import type { Forge } from "../forge/types.ts";
import type { Answered, ApprovalRequest, Approver } from "./approver.ts";
import { ANSWER_KIND } from "./approver.ts";
import { commandAuthors, matchCommands, readPermissions } from "./forge-match.ts";
import { readRequests, type RequestsState, requestComment } from "./requests.ts";

export {
	type ClassChange,
	type CommandMatch,
	commandAuthors,
	type MatchOptions,
	type MatchResult,
	matchCommands,
	type Permission,
	type Permissions,
	readPermissions,
} from "./forge-match.ts";

/** Thrown by `request` when a request for the same subject is already pending or applying. */
export class DuplicateRequestError extends Error {
	constructor(readonly pendingId: string, subject: string) {
		super(`A request for ${subject} is pending (${pendingId}): wait for its answer or end it with /livespec dismiss.`);
		this.name = "DuplicateRequestError";
	}
}

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

/** The id of a pending or applying request for `subject`, if any. */
function openRequestFor(requests: RequestsState, subject: string): string | undefined {
	return (requests.pending.find((p) => p.subject === subject) ?? requests.applying.find((a) => a.subject === subject))?.id;
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
			const open = openRequestFor(readRequests(comments), r.subject);
			if (open !== undefined) throw new DuplicateRequestError(open, r.subject);
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
			const { perms } = await readPermissions(forge, commandAuthors(comments, pending));
			const match = matchCommands(pending, comments, perms, { marked }).matches[0];
			return match ? match.answer : { status: "pending" };
		},
	};
}
