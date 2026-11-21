// The change diff (design D2): `git diff <M>..HEAD` with M the merge base of HEAD and the fetched integration
// branch, so work brought in by an integration merge is not part of the change. Falls back to `Base`.

import { matchGlob } from "../core/glob.ts";
import type { Unit } from "../core/change.ts";
import { type DiffEntry, diffFilesOf, type Git } from "../engine/git.ts";

export type ChangeDiff = { from: string; entries: DiffEntry[]; files: string[] };

const REMOTE = "origin";
const SPECS_PREFIX = "specs/";

/** The merge base of HEAD and `origin/<integration>` after a fetch; undefined when the fetch or the ref fails. */
async function integrationMergeBase(git: Git, integration: string): Promise<string | undefined> {
	try {
		await git.fetch(REMOTE, integration);
		if ((await git.remoteRef(`${REMOTE}/${integration}`)) === undefined) return undefined;
		return await git.mergeBase("HEAD", `${REMOTE}/${integration}`);
	} catch {
		return undefined;
	}
}

export async function changeDiff(git: Git, base: string | undefined, integration: string): Promise<ChangeDiff | { refused: string }> {
	const from = (await integrationMergeBase(git, integration)) ?? base;
	if (from === undefined) return { refused: `no change diff: cannot fetch origin/${integration} and the issue has no Base line` };
	const entries = await git.diffNameStatus(from, "HEAD");
	return { from, entries, files: diffFilesOf(entries) };
}

/** Files that no unit lists (exactly or by glob) and that are not spec files. */
export function filesOutsideUnits(files: string[], units: Unit[]): string[] {
	const patterns = units.flatMap((u) => u.files);
	return files.filter((f) => !f.startsWith(SPECS_PREFIX) && !patterns.some((p) => p === f || matchGlob(p, f)));
}
