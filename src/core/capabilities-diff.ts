import type { Change } from "./change.ts";
import type { Result } from "./result.ts";

const DIFF_HEADER = /^diff --git a\/(\S+) b\/(\S+)$/;
// specs/<cap>/<file>: top-level specs/*.md and specs/decisions/ are not capabilities.
const CAP_PATH = /^specs\/([^/]+)\/.+/;

type Touched = { touched: Set<string>; created: Set<string> };

function parseDiff(diff: string): Touched {
	const touched = new Set<string>();
	const created = new Set<string>();
	let cap: string | undefined;
	for (const raw of diff.split(/\r?\n/)) {
		const h = DIFF_HEADER.exec(raw);
		if (h) {
			const c = CAP_PATH.exec(h[2] as string)?.[1];
			cap = c && c !== "decisions" ? c : undefined;
			if (cap) touched.add(cap);
			continue;
		}
		if (cap && (raw.startsWith("new file mode") || raw === "--- /dev/null")) created.add(cap);
	}
	return { touched, created };
}

function error(message: string): Result {
	return { code: "capabilities-match-diff", severity: "error", section: "Capabilities", message };
}

/** Compares the declared `Capabilities` line with `git diff <Base>..HEAD -- specs/`. */
export function capabilitiesMatchDiff(c: Change, diff: string): Result[] {
	if (c.header.base === undefined) {
		return [{ code: "change-not-started", severity: "warning", message: "Change is not started: no Base line" }];
	}
	const declared = c.header.capabilities ?? { new: [], modified: [] };
	const { touched, created } = parseDiff(diff);
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
