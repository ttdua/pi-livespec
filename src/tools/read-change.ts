// The common start of the read tools and `/livespec next`: rebuild the
// snapshot, then return the resolved change, the open changes, or a refusal
// (invalid pack first, so nothing is computed from it).

import type { Session } from "../hooks/session.ts";
import { type CurrentChange, currentChange, requireValidPack } from "./guard.ts";

export async function readCurrentChange(session: Session): Promise<CurrentChange> {
	const pack = requireValidPack(session);
	if (!pack.ok) return { kind: "refused", message: pack.message };
	await session.refresh();
	return currentChange(session);
}
