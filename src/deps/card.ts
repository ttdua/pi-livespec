// The `parked` card section (spec context-injection "Phase card content"): what a parked change waits for,
// with the dependency states read at refresh, and each parked unit's wip branch. Pure.

import type { ChangeState } from "../engine/state-types.ts";
import { type CardSection, registerCardSection, untrusted } from "../hooks/phase-card.ts";

type Parked = NonNullable<ChangeState["parked"]>;

/** Before the refresh fills the states (or when the forge could not be read), the record's numbers alone. */
function waitsLine(state: ChangeState): string {
	const waits = state.parked?.waitsFor.map((d) => `#${d.number} ${d.state}`) ?? state.parkedCore?.waitsFor.map((n) => `#${n}`) ?? [];
	return waits.length === 0 ? "parked, waiting for no change: a human runs change_resume" : `parked, waiting for ${waits.join(", ")}`;
}

/** Unit ids and branch names come from the forge record, so they are wrapped as untrusted. */
const unitLine = (u: Parked["units"][number]): string => `- ${untrusted(u.unit)}${u.lane ? " (lane)" : ""}${u.branch === undefined ? " (no work kept)" : `: ${untrusted(u.branch)}`}`;

export const parkedSection: CardSection = (i) => {
	if (i.kind !== "change" || i.state.parkedCore === undefined) return undefined;
	const units = i.state.parked?.units ?? i.state.parkedCore.units;
	return [waitsLine(i.state), ...(units.length === 0 ? [] : ["wip branches:", ...units.map(unitLine)])].join("\n");
};

registerCardSection("parked", parkedSection);
