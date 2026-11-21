// Ship freshness (design D4): human input newer than the ship gate comment, or an issue that no longer matches
// the ship request, makes the ship approval stale.

import { gateDigest } from "../engine/locks.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { parseMarked } from "../forge/markers.ts";
import type { Comment, Forge } from "../forge/types.ts";

const SHIP = "ship";

/** The issue's comments minus the account's own marked ones (author is `login` and a marker parses). */
export async function humanThreadComments(forge: Forge, issue: number, login: string): Promise<Comment[]> {
	return humanVoices(await forge.listComments(issue), login);
}

/** `humanThreadComments` over comments already read. */
export function humanVoices(comments: Comment[], login: string): Comment[] {
	return comments.filter((c) => !(c.author === login && parseMarked(c.body) !== null));
}

const time = (iso: string): number => new Date(iso).getTime();

/**
 * Why the ship approval is stale: `missing` when freshness cannot be checked, `comment` for a human comment newer
 * than the gate comment, `digest` (with the issue's current gate digest) for an issue that no longer matches.
 */
export type ShipStaleness =
	| { kind: "missing"; reason: string }
	| { kind: "comment"; reason: string; comment: Comment }
	| { kind: "digest"; reason: string; digest: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * The `gate_digest` the ship request recorded: from the forge `request` comment, else from the `answer` comment,
 * which holds the full request (an in-session answer never posts a `request` comment).
 */
function requestDigest(state: ChangeState, request: string): unknown {
	const posted = state.marked.find((m) => m.kind === "request" && m.id === request);
	if (isObject(posted?.data)) return posted.data.gate_digest;
	const answer = state.marked.find((m) => m.kind === "answer" && m.id === request);
	return isObject(answer?.data) && isObject(answer.data.request) ? answer.data.request.gate_digest : undefined;
}

/**
 * The ship approval's staleness, or undefined when fresh. `gateComment` is the forge comment of the ship gate
 * (found by `GateResult.commentId`); `humans` is the output of `humanThreadComments`.
 */
export function shipStaleness(state: ChangeState, gateComment: Comment | undefined, humans: Comment[]): ShipStaleness | undefined {
	const gate = state.lock.gates[SHIP];
	if (gate === undefined) return { kind: "missing", reason: "the ship gate has no approval" };
	const digest = gate.request === undefined ? undefined : requestDigest(state, gate.request);
	if (gateComment === undefined || typeof digest !== "string") {
		return { kind: "missing", reason: "the ship gate's comment or request record is missing, so freshness cannot be checked" };
	}
	const since = time(gateComment.createdAt);
	const newer = humans.find((c) => time(c.createdAt) > since || time(c.updatedAt) > since);
	if (newer !== undefined) return { kind: "comment", reason: `a human comment (${newer.id}) was added or edited after the ship gate`, comment: newer };
	const current = gateDigest(state.change.lines.map((l) => l.text).join("\n"));
	if (current !== digest) return { kind: "digest", reason: "the issue changed since the ship gate request", digest: current };
	return undefined;
}

/** The reason the ship approval is stale, or undefined when fresh (see `shipStaleness`). */
export function shipStale(state: ChangeState, gateComment: Comment | undefined, humans: Comment[]): string | undefined {
	return shipStaleness(state, gateComment, humans)?.reason;
}
