// Freshness of a dispatched unit at `unit_finish`: stale sources of its last packet stop the unit through `spec_stuck`.

import type { Git } from "../engine/git.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { CachedForge } from "../forge/cache.ts";
import { checkFreshness, readCurrent } from "./freshness.ts";
import { changeName } from "./packet.ts";
import { readPacket } from "./packet-store.ts";
import { latestDispatch } from "./records.ts";
import type { PacketContext } from "./source-types.ts";
import type { SpecStuckParams } from "../tools/spec-stuck.ts";

export type FinishFacts = { session: { activeTree?: string }; state: ChangeState; pack: Pack; forge: CachedForge; git: Git; root: string; cwd: string; budgetTokens: number };

/**
 * The sources that changed since the unit's last dispatch, or undefined when there is nothing to check: no dispatch
 * record (an inline unit has no packet). A dispatch whose stored packet cannot be read, or a re-read that throws,
 * counts as stale.
 */
export async function staleSince(f: FinishFacts, unit: string): Promise<string[] | undefined> {
	const dispatch = latestDispatch(f.state.marked, unit, "implementer");
	if (dispatch === undefined) return undefined;
	const ctx: PacketContext = { ...f };
	const packet = await readPacket(f.root, changeName(ctx), dispatch.packet);
	if (packet === undefined) return [`packet unavailable: ${dispatch.packet}`];
	try {
		const stale = checkFreshness(packet, await readCurrent(ctx, dispatch.role, unit, dispatch.subject), dispatch.agentId).stale;
		return stale.length === 0 ? undefined : stale;
	} catch (error) {
		return [`unreadable: ${error instanceof Error ? error.message : String(error)}`];
	}
}

const HYPOTHESIS_MAX = 600;
const HYPOTHESIS_PREFIX = "Changed since the dispatch: ";
const HYPOTHESIS_SUFFIX = ". The work may not reflect them.";
const ELLIPSIS = "…";

const more = (k: number): string => `and ${k} more`;
const hypothesisOf = (listed: string[], dropped: number): string => `${HYPOTHESIS_PREFIX}${[...listed, ...(dropped > 0 ? [more(dropped)] : [])].join(", ")}${HYPOTHESIS_SUFFIX}`;
const size = (s: string): number => [...s].length;

/** The hypothesis within 600 code points: whole stale entries are dropped from the end; a lone entry too long is cut. */
function hypothesisFor(entries: string[]): string {
	const stale = entries.map((s) => s.replace(/\s+/g, " ").trim());
	for (let kept = stale.length; kept > 0; kept--) {
		const text = hypothesisOf(stale.slice(0, kept), stale.length - kept);
		if (size(text) <= HYPOTHESIS_MAX) return text;
	}
	const rest = stale.length - 1;
	const room = HYPOTHESIS_MAX - size(hypothesisOf([ELLIPSIS], rest));
	return hypothesisOf([`${[...(stale[0] ?? "")].slice(0, Math.max(0, room)).join("")}${ELLIPSIS}`], rest);
}

/** The `spec_stuck` parameters that name the stale sources of `unit`. */
export function stuckFor(unit: string, stale: string[]): SpecStuckParams {
	return {
		where: `unit_finish ${unit}: the sources of its dispatched packet changed`,
		tried: [{ text: `unit_finish ${unit} compared the packet's sources and the comment threads with the dispatch` }],
		hypothesis: hypothesisFor(stale),
		options: [
			{ id: "redispatch", label: `Re-dispatch ${unit} with the new context`, description: "Start the unit again from a packet built on the changed sources" },
			{ id: "amend", label: `Amend ${unit} with unit_amend to take the new input into account`, description: "Keep the work so far and change the unit to follow the new input" },
		],
		recommended: "redispatch",
		rationale: "The packet was built before the sources changed, so a fresh dispatch is the safest way to include them.",
	};
}
