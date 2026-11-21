// De-duplication of reviewer and parent findings into aggregate findings (design D3). Pure.

import type { AggregateFinding } from "../subagents/records.ts";
import type { Finding } from "../subagents/roles.ts";
import { CHECK_PREFIX, normalizeLocation, type Route } from "./route.ts";

export type MergedFinding = Finding & { from: string[]; needsDecision: boolean };

const PARENT = "parent";
const SEVERITY_RANK: Record<Finding["severity"], number> = { CRITICAL: 3, WARNING: 2, SUGGESTION: 1 };

const higher = (a: Finding["severity"], b: Finding["severity"]): Finding["severity"] => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a);

/**
 * Parent findings first, then each review's findings, de-duplicated by `${path}:${line}:${kind}` of the normalized
 * location. A merged finding keeps the highest severity, the first evidence and fix, every source key and
 * the `needs-decision` mark of any source. With `keepParents` (a pull request feedback round) each parent finding
 * stays its own item: the round's comments share a location but are separate feedback.
 */
export function mergeFindings(input: { parent: Finding[]; reviews: { commentId: string; findings: Finding[] }[] }, opts: { keepParents?: boolean } = {}): MergedFinding[] {
	const sources = [
		...input.parent.map((finding) => ({ finding, from: PARENT })),
		...input.reviews.flatMap((r) => r.findings.map((finding, i) => ({ finding, from: `${r.commentId}:${i}` }))),
	];
	const merged = new Map<string, MergedFinding>();
	for (const { finding, from } of sources) {
		const check = finding.location.startsWith(CHECK_PREFIX);
		const { path, line } = check ? { path: finding.location, line: 0 } : normalizeLocation(finding.location);
		const base = `${path}:${line}:${finding.kind}`;
		let key = base;
		if (opts.keepParents === true && from === PARENT) for (let n = 1; merged.get(key)?.from.includes(PARENT) === true; n++) key = `${base}#${n}`;
		const marked = finding.scope === "needs-decision";
		const seen = merged.get(key);
		if (seen === undefined) merged.set(key, { ...finding, location: check ? path : `${path}:${line}`, from: [from], needsDecision: marked });
		else merged.set(key, { ...seen, severity: higher(seen.severity, finding.severity), from: [...seen.from, from], needsDecision: seen.needsDecision || marked });
	}
	return [...merged.values()];
}

function verifyOf(f: MergedFinding, verifierOff: boolean): AggregateFinding["verify"] {
	if (f.from.includes(PARENT)) return "skipped-parent";
	if (f.kind === "missed-context") return "skipped-missed-context";
	if (f.severity === "SUGGESTION") return "skipped-suggestion";
	return verifierOff ? "skipped-off" : "required";
}

/** Attaches each merged finding's route (same index in `routes`) and whether it needs the verifier. */
export function withRoutes(merged: MergedFinding[], routes: { route: Route; unit?: string }[], verifierOff: boolean): AggregateFinding[] {
	return merged.map((f, i) => {
		const routed = routes[i];
		if (routed === undefined) throw new Error(`no route for merged finding ${i}`);
		return { ...f, route: routed.route, ...(routed.unit === undefined ? {} : { routeUnit: routed.unit }), verify: verifyOf(f, verifierOff) };
	});
}
