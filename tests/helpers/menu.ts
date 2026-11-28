/** The menu entry for `label`: equal to it, or `<label> — <description>` / `<label> (Recommended)`. */
export function pickByLabel(options: string[], label: string): string | undefined {
	return options.find((o) => o === label || o.startsWith(`${label} — `) || o.startsWith(`${label} (Recommended)`));
}

/** Labels of the options the gate tests pick by id. */
const LABELS: Record<string, string> = { waive: "Waive size-limits", accept: "accept the dependency", A: "A: create the prerequisite change and park this one until it merges", B: "B: add the missing work to this change as new units (unit_amend --add)", C: "C: stub the missing part now and create a follow-up change", D: "D: send the change back to shape, or drop it", unchanged: "Behavior did not change", changed: "Behavior changed; the spec must be updated" };

/** Picks the entry of the option with `id`; a text that is not a known id is taken as the label. */
export function pickById(options: string[], id: string): string | undefined {
	return pickByLabel(options, LABELS[id] ?? id);
}
