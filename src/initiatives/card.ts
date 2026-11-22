// The `initiative` card section: initiative progress, dependency states, ready entries, the capability
// overlap warning and, in `shape`, the `initiative_propose` suggestion. Pure; forge text is untrusted.

import type { ChangeState } from "../engine/state-types.ts";
import { type CardSection, registerCardSection, untrusted } from "../hooks/phase-card.ts";

type Deps = NonNullable<ChangeState["deps"]>;

const SHAPE_PHASE = "shape";
const SPLIT_LINE = "This change exceeds the pack size limits: propose it as an initiative with initiative_propose.";

function initiativeLines(i: NonNullable<Deps["initiative"]>): string[] {
	return [
		`initiative #${i.number}: ${i.checked} of ${i.total} done`,
		...i.ready.map((r) => `Ready to start: #${r.number} ${untrusted(r.name)} (a human runs change_start #${r.number})`),
	];
}

const overlapLine = (o: Deps["overlap"][number]): string =>
	`Warning: #${o.number} ${untrusted(o.title)} also changes ${o.capabilities.map(untrusted).join(", ")}`;

/** In `shape`, a change without an initiative whose `split` outcome is `propose`. */
const suggestsSplit = (state: ChangeState, deps: Deps): boolean =>
	deps.split === "propose" && state.change.header.initiative === undefined && state.phase.kind === "ok" && state.phase.id === SHAPE_PHASE;

export const initiativeSection: CardSection = (i) => {
	if (i.kind !== "change" || i.state.deps === undefined) return undefined;
	const deps = i.state.deps;
	const lines = [
		...(deps.initiative ? initiativeLines(deps.initiative) : []),
		...(deps.items.length === 0 ? [] : [`Depends: ${deps.items.map((d) => `#${d.number} ${d.state}`).join(", ")}`]),
		...deps.overlap.map(overlapLine),
		...(suggestsSplit(i.state, deps) ? [SPLIT_LINE] : []),
	];
	return lines.length === 0 ? undefined : lines.join("\n");
};

registerCardSection("initiative", initiativeSection);
