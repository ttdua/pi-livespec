// Reading the forge permissions of command authors (design D4): the async I/O
// that feeds the pure matcher in `forge-match.ts`.

import { messageOf } from "../core/messages.ts";
import { parseMarked } from "../forge/markers.ts";
import type { Comment, Forge } from "../forge/types.ts";
import { REQUEST_KIND } from "./approver.ts";
import type { Permission } from "./forge-match.ts";
import type { PendingRequest } from "./requests.ts";

const PREFIX = "/livespec ";

/** Position of the request's own comment in `comments`, or -1 when it is not there. */
function requestIndex(comments: Comment[], id: string): number {
	return comments.findIndex((c) => {
		const m = parseMarked(c.body);
		return m?.kind === REQUEST_KIND && m.id === id;
	});
}

/** Authors of `/livespec ` comments after the earliest pending request, each once, in order. */
export function commandAuthors(comments: Comment[], pending: PendingRequest[]): string[] {
	const found = pending.map((p) => requestIndex(comments, p.id)).filter((i) => i !== -1);
	const from = found.length === pending.length && found.length > 0 ? Math.min(...found) : -1;
	return [...new Set(comments.filter((c, i) => i > from && c.body.startsWith(PREFIX)).map((c) => c.author))];
}

export type Permissions = { perms: Map<string, Permission>; warnings: string[] };

/** `getPermission` once per author; a failed lookup counts as no access (fail closed) with a warning. */
export async function readPermissions(forge: Pick<Forge, "getPermission">, authors: string[]): Promise<Permissions> {
	const out: Permissions = { perms: new Map(), warnings: [] };
	for (const author of authors) {
		try {
			out.perms.set(author, await forge.getPermission(author));
		} catch (error) {
			out.perms.set(author, "none");
			out.warnings.push(`cannot read the permission of ${author} (${messageOf(error)}); their /livespec comments count as without write access`);
		}
	}
	return out;
}
