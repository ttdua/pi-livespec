// Skill directories handed to pi on `resources_discover`: the pack's skills under
// the active commit's real `<sha>/` path, so a running session stays on one tree.

import { join } from "node:path";
import type { LoadedPack } from "../engine/pack-types.ts";
import { packSkillNames } from "./pack-skills.ts";

export { EXCLUDED_SKILLS } from "./pack-skills.ts";

/** `activeTree` is `ContentManager.activeTree()`, the realpath of `current`; nothing is exposed without it. */
export function exposedSkillPaths(i: { initialized: boolean; pack: LoadedPack; activeTree?: string }): string[] {
	if (!i.initialized || !i.pack.ok || i.activeTree === undefined) return [];
	const tree = i.activeTree;
	return packSkillNames(i.pack.pack).map((name) => join(tree, "skills", name));
}
