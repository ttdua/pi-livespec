// The flow block of a packet: which skills a role gets from the active pack and where they live in the content tree.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Pack, Phase } from "../engine/pack-types.ts";
import { entriesFor } from "./policy.ts";
import type { ReviewSubject, Role } from "./roles.ts";

export type SkillPaths = { ok: true; paths: string[]; names: string[] } | { ok: false; missing: string[] };

const SKILL_FILE = "SKILL.md";

/** Skill names of the pack's `subagents` entry for the role (and subject), else `skills.required` for the implementer, else none. */
function skillNames(pack: Pack, phaseId: string, role: Role, subject: ReviewSubject | undefined): string[] {
	const entries = entriesFor(pack, phaseId).filter((e) => e.role === role);
	const entry = entries.find((e) => e.subject === subject && e.skills !== undefined) ?? entries.find((e) => e.subject === undefined && e.skills !== undefined);
	if (entry?.skills !== undefined) return entry.skills;
	const phase: Phase | undefined = pack.phases.find((p) => p.id === phaseId);
	return role === "implementer" ? [...(phase?.skills?.required ?? [])] : [];
}

/** Absolute `SKILL.md` paths in the active tree; a skill missing from the tree is reported by name. */
export function roleSkillPaths(pack: Pack, phase: string, role: Role, tree: string | undefined, subject?: ReviewSubject): SkillPaths {
	const names = skillNames(pack, phase, role, subject);
	const paths = names.map((name) => (tree === undefined ? "" : join(tree, "skills", name, SKILL_FILE)));
	const missing = names.filter((_, i) => tree === undefined || !existsSync(paths[i] as string));
	return missing.length > 0 ? { ok: false, missing } : { ok: true, paths, names };
}
