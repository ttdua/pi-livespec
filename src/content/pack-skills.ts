// The skills a pack names, shared by the compatibility check, skill-change
// notices and exposure.

import type { Pack } from "../engine/pack-types.ts";

/** Never exposed nor required, even when a pack names them. */
export const EXCLUDED_SKILLS = ["using-agent-skills", "context-engineering"] as const;

const isExcluded = (name: string): boolean => (EXCLUDED_SKILLS as readonly string[]).includes(name);

/** Sorted unique names from `init.skills` and every phase's required and optional skills, minus the excluded ones. */
export function packSkillNames(pack: Pack): string[] {
	const names = new Set(pack.init.skills);
	for (const phase of pack.phases) for (const name of [...phase.skills.required, ...phase.skills.optional]) names.add(name);
	return [...names].filter((name) => !isExcluded(name)).sort();
}
