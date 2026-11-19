// Freshness before finish: which sources of a dispatched packet changed or gained a human voice since.

import { collectSources } from "./sources.ts";
import { humanComments, makeReads } from "./source-kit.ts";
import type { ReviewSubject, Role } from "./roles.ts";
import type { Packet, PacketContext } from "./source-types.ts";
import { resolveTarget } from "./target.ts";

/** The re-read side: current source versions and the human comments now on the change and its pull request. */
export type Current = { sources: { id: string; version: string }[]; humanComments: { id: string; version: string }[] };

/** How a human comment is remembered in `Packet.seen`: an edit changes the key. */
export const seenKey = (c: { id: string; version: string }): string => `${c.id}@${c.version}`;

/** Ids that a new human answer or review comment would add to the manifest. */
const HUMAN_VOICE = /^(answer:|review:)/;

/**
 * Stale sources: every old source is revalidated (a changed version, or a source that is gone or unreadable, is stale), a human comment (new or edited) since the build, and a new answered
 * question, child answer (`answer:Q<n>` or `answer:<agentId>:<n>`) or review comment the manifest would now include. Own marked comments never count here.
 */
export function checkFreshness(packet: Packet, current: Current): { stale: string[] } {
	const stale = new Set<string>();
	const now = new Map(current.sources.map((s) => [s.id, s.version]));
	for (const s of packet.sources) {
		if (now.get(s.id) !== s.version) stale.add(s.id);
	}
	const known = new Set(packet.sources.map((s) => s.id));
	for (const s of current.sources) if (HUMAN_VOICE.test(s.id) && !known.has(s.id)) stale.add(s.id);
	const seen = new Set(packet.seen);
	for (const c of current.humanComments) if (!seen.has(seenKey(c))) stale.add(c.id);
	return { stale: [...stale] };
}

/** Re-reads the manifest of the same role, unit and subject and the comment threads. Throws on a forge or provider failure. */
export async function readCurrent(ctx: PacketContext, role: Role, unit?: string, subject?: ReviewSubject): Promise<Current> {
	const target = resolveTarget(ctx.state, role, unit, subject);
	if (!target.ok) throw new Error(target.message);
	const reads = makeReads(ctx.forge);
	const placed = await collectSources(ctx, target.target, reads);
	return { sources: placed.map((p) => ({ id: p.source.id, version: p.source.version })), humanComments: await humanComments(ctx, reads) };
}
