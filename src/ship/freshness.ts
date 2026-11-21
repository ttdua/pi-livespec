// Ship freshness (design D4): human input newer than the ship gate comment, or an issue that no longer matches
// the ship request, makes the ship approval stale.

import { gateDigest } from "../engine/locks.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { parseMarked } from "../forge/markers.ts";
import type { Comment, Forge } from "../forge/types.ts";

const SHIP = "ship";

/** The issue's comments minus the account's own marked ones (author is `login` and a marker parses). */
export async function humanThreadComments(forge: Forge, issue: number, login: string): Promise<Comment[]> {
	return (await forge.listComments(issue)).filter((c) => !(c.author === login && parseMarked(c.body) !== null));
}

const time = (iso: string): number => new Date(iso).getTime();

/** The reason the ship approval is stale, or undefined when fresh. `comments` are the human comments (and may hold the gate comment). */
export function shipStale(state: ChangeState, comments: Comment[]): string | undefined {
	const gate = state.lock.gates[SHIP];
	if (gate === undefined) return "the ship gate has no approval";
	const gateComment = comments.find((c) => c.id === gate.commentId);
	const request = gate.request === undefined ? undefined : state.marked.find((m) => m.kind === "request" && m.id === gate.request);
	const digest = (request?.data as { gate_digest?: unknown } | null | undefined)?.gate_digest;
	if (gateComment === undefined || typeof digest !== "string") return "the ship gate's comment or request record is missing, so freshness cannot be checked";
	const since = time(gateComment.createdAt);
	const newer = comments.find((c) => c.id !== gate.commentId && (time(c.createdAt) > since || time(c.updatedAt) > since));
	if (newer !== undefined) return `a human comment (${newer.id}) was added or edited after the ship gate`;
	const body = state.change.lines.map((l) => l.text).join("\n");
	if (gateDigest(body) !== digest) return "the issue changed since the ship gate request";
	return undefined;
}
