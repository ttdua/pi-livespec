import { filterMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import type { Answered } from "../../src/interaction/approver.ts";
import { commandAuthors, matchCommands, readPermissions } from "../../src/interaction/forge.ts";
import { readRequests } from "../../src/interaction/requests.ts";

/** The answer a writer's command gives the pending request `id` right now, or undefined when none matches. */
export async function matchedAnswer(forge: Forge, n: number, id: string): Promise<Answered | undefined> {
	const [{ login }, comments] = await Promise.all([forge.whoami(), forge.listComments(n)]);
	const marked = filterMarked(comments, login).comments;
	const pending = readRequests(marked).pending.filter((p) => p.id === id);
	if (pending.length === 0) return undefined;
	const { perms } = await readPermissions(forge, commandAuthors(comments, pending));
	return matchCommands(pending, comments, perms, { marked }).matches[0]?.answer;
}
