// Compatibility of an agent-skills tree with a pack: every pack skill has a
// valid `SKILL.md` and every persona the pack references exists in `agents/`.

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { Pack } from "../engine/pack-types.ts";
import { personasForPack } from "../engine/registry.ts";
import { packSkillNames } from "./pack-skills.ts";

export type CompatFailure = { item: string; reason: string };
export type CompatResult = { ok: boolean; failures: CompatFailure[] };

/** pi's skill name rules. */
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const FENCE = "---";

export async function checkCompat(tree: string, pack: Pack): Promise<CompatResult> {
	const failures: CompatFailure[] = [];
	for (const name of packSkillNames(pack)) {
		const reason = await skillProblem(tree, name);
		if (reason) failures.push({ item: name, reason });
	}
	for (const persona of personasForPack(pack)) {
		if (!(await exists(join(tree, "agents", `${persona}.md`)))) failures.push({ item: persona, reason: `agents/${persona}.md is missing` });
	}
	return { ok: failures.length === 0, failures };
}

async function skillProblem(tree: string, name: string): Promise<string | undefined> {
	const file = join(tree, "skills", name, "SKILL.md");
	const text = await readOptional(file);
	if (text === undefined) return `skills/${name}/SKILL.md is missing`;
	const front = frontMatter(text);
	if (front === undefined) return "SKILL.md has no front matter";
	let value: unknown;
	try {
		value = parse(front);
	} catch (error) {
		return `front matter is not valid YAML (${(error as Error).message.split("\n")[0]})`;
	}
	return frontMatterProblem(value, name);
}

function frontMatterProblem(value: unknown, dirName: string): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "front matter is not a YAML map";
	const { name, description } = value as Record<string, unknown>;
	if (typeof name !== "string") return "front matter has no string `name`";
	if (name !== dirName) return `name \`${name}\` does not match the directory \`${dirName}\``;
	if (name.length > MAX_NAME_LENGTH || !SKILL_NAME.test(name)) return `name \`${name}\` breaks pi's skill name rules`;
	if (typeof description !== "string") return "front matter has no string `description`";
	if (description.length < 1 || description.length > MAX_DESCRIPTION_LENGTH) {
		return `description has ${description.length} characters; expected 1 to ${MAX_DESCRIPTION_LENGTH}`;
	}
	return undefined;
}

/** The text between the first two `---` lines; the file must open with the first one. */
function frontMatter(text: string): string | undefined {
	const lines = text.split(/\r?\n/);
	if (lines[0] !== FENCE) return undefined;
	const end = lines.indexOf(FENCE, 1);
	return end === -1 ? undefined : lines.slice(1, end).join("\n");
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
