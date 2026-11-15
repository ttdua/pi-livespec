// Optional skills whose SKILL.md the agent read in this session. The set only
// drives the skill-note reminder on the phase card; it is never state.

import { isAbsolute, join, relative, sep } from "node:path";

const SKILL_FILE = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/;

/** The skill name when `path` (absolute, or relative to `cwd`) is `<activeTree>/skills/<name>/SKILL.md`. */
export function skillOfRead(path: string, cwd: string, activeTree: string): string | undefined {
	const absolute = isAbsolute(path) ? path : join(cwd, path);
	const rel = relative(activeTree, absolute);
	if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return SKILL_FILE.exec(rel.split(sep).join("/"))?.[1];
}

export class SkillReads {
	private readonly names = new Set<string>();

	record(name: string): void {
		this.names.add(name);
	}

	has(name: string): boolean {
		return this.names.has(name);
	}

	list(): string[] {
		return [...this.names].sort();
	}
}
