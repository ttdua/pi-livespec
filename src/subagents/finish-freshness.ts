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
 * record (an inline unit has no packet) or a packet that was never stored. A re-read that throws counts as stale.
 */
export async function staleSince(f: FinishFacts, unit: string): Promise<string[] | undefined> {
	const dispatch = latestDispatch(f.state.marked, unit, "implementer");
	if (dispatch === undefined) return undefined;
	const ctx: PacketContext = { ...f };
	const packet = await readPacket(f.root, changeName(ctx), dispatch.packet);
	if (packet === undefined) return undefined;
	try {
		const stale = checkFreshness(packet, await readCurrent(ctx, dispatch.role, unit, dispatch.subject), dispatch.agentId).stale;
		return stale.length === 0 ? undefined : stale;
	} catch (error) {
		return [`unreadable: ${error instanceof Error ? error.message : String(error)}`];
	}
}

/** The `spec_stuck` parameters that name the stale sources of `unit`. */
export function stuckFor(unit: string, stale: string[]): SpecStuckParams {
	return {
		where: `unit_finish ${unit}: the sources of its dispatched packet changed`,
		tried: [{ text: `unit_finish ${unit} compared the packet's sources and the comment threads with the dispatch` }],
		hypothesis: `Changed since the dispatch: ${stale.join(", ")}. The work may not reflect them.`,
		options: [
			{ id: "redispatch", label: `Re-dispatch ${unit} with the new context` },
			{ id: "amend", label: `Amend ${unit} with unit_amend to take the new input into account` },
		],
		recommended: "redispatch",
	};
}
