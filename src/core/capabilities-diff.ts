import type { Change } from "./change.ts";
import { type GitDiffFile, parseGitDiff } from "./git-diff.ts";
import type { Result } from "./result.ts";

// specs/<cap>/<file>: top-level specs/*.md and specs/decisions/ are not capabilities.
const CAP_PATH = /^specs\/([^/]+)\/.+/;

function capOf(path: string): string | undefined {
	const c = CAP_PATH.exec(path)?.[1];
	return c && c !== "decisions" ? c : undefined;
}

type Touched = { touched: Set<string>; created: Set<string> };

/** Collects touched capabilities; a rename touches source and destination, and a destination created by rename counts as created. */
function collect(files: GitDiffFile[]): Touched {
	const touched = new Set<string>();
	const created = new Set<string>();
	for (const f of files) {
		const from = capOf(f.oldPath);
		const to = capOf(f.newPath);
		if (from) touched.add(from);
		if (to) touched.add(to);
		if (to && (f.newFile || f.renamed)) created.add(to);
	}
	return { touched, created };
}

function error(message: string): Result {
	return { code: "capabilities-match-diff", severity: "error", section: "Capabilities", message };
}

/** Compares the declared `Capabilities` line with `git diff <Base>..HEAD -- specs/`. */
export function capabilitiesMatchDiff(c: Change, diff: string): Result[] {
	if (c.header.base === undefined) {
		return [{ code: "change-not-started", severity: "warning", section: "Capabilities", message: "Change is not started: no Base line" }];
	}
	const declared = c.header.capabilities ?? { new: [], modified: [] };
	const { touched, created } = collect(parseGitDiff(diff));
	const results: Result[] = [];
	for (const cap of [...declared.new, ...declared.modified]) {
		if (!touched.has(cap)) results.push(error(`Capability ${cap} is declared but the diff does not touch specs/${cap}/`));
	}
	for (const cap of declared.new) {
		if (touched.has(cap) && !created.has(cap)) results.push(error(`Capability ${cap} is declared new but the diff does not create specs/${cap}/`));
	}
	const all = new Set([...declared.new, ...declared.modified]);
	for (const cap of touched) {
		if (!all.has(cap)) results.push(error(`Capability ${cap} is touched by the diff but not declared`));
	}
	return results;
}
