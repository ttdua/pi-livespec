// Bare work: a tracked file outside `specs/` edited while neither a change nor a fix branch is checked out.
// The guard logs it in `specs/bare-work.md` (design D7); logging is advisory and never blocks a call.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseBareWork } from "../core/bare-work.ts";
import { CHANGE_BRANCH_PREFIX } from "../engine/resolve-change.ts";
import { fixSlug } from "../fix/branch.ts";

export type BareWorkInput = { root: string; path: string; branch: string; tracked: (p: string) => Promise<boolean> };

const SPECS_DIR = "specs";
const LOG_FILE = join(SPECS_DIR, "bare-work.md");

/** The path relative to the project root with `/` separators, or undefined when it lies outside the root. */
function relativeToRoot(root: string, path: string): string | undefined {
	const rel = relative(root, resolve(root, path));
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
	return rel.split(sep).join("/");
}

/** The path relative to the project root when the edit is bare work; rejects when `tracked` rejects. */
export async function isBareWork(i: BareWorkInput): Promise<string | undefined> {
	if (i.branch.startsWith(CHANGE_BRANCH_PREFIX) || fixSlug(i.branch) !== undefined) return undefined;
	const rel = relativeToRoot(i.root, i.path);
	if (rel === undefined || rel.startsWith(`${SPECS_DIR}/`)) return undefined;
	return (await i.tracked(rel)) ? rel : undefined;
}

/** Serializes appends so parallel edits of one path log once. */
let chain: Promise<unknown> = Promise.resolve();

async function append(root: string, rel: string, tool: string, date: string): Promise<{ written: boolean; error?: string }> {
	try {
		const file = join(root, LOG_FILE);
		let text = "";
		try {
			text = await readFile(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (parseBareWork(text).entries.some((e) => e.date === date && e.files.includes(rel))) return { written: false };
		await mkdir(join(root, SPECS_DIR), { recursive: true });
		const lead = text !== "" && !text.endsWith("\n") ? "\n" : "";
		await appendFile(file, `${lead}${date} — ${rel} — ${tool} outside a change or fix branch\n`);
		return { written: true };
	} catch (error) {
		return { written: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Appends the bare-work line unless the same path is already logged for `date`; never rejects. */
export function appendBareWork(root: string, rel: string, tool: "write" | "edit", date: string): Promise<{ written: boolean; error?: string }> {
	const run = chain.then(() => append(root, rel, tool, date));
	chain = run;
	return run;
}

/** `YYYY-MM-DD` of the local date. */
export function localDate(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
