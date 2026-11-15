// The seven steps of `plan_units` (design D9), one function each. Every step
// that can fail returns a refusal or an outcome instead of throwing, so the
// tool can stop before the first write and settle an unknown write outcome.

import { formatResults } from "../commands/validate.ts";
import { parseChange } from "../core/change.ts";
import { messageOf } from "../core/messages.ts";
import type { Result } from "../core/result.ts";
import { replaceSection, sectionText, setHeaderLine } from "../core/sections.ts";
import { renderUnit, type RenderableUnit, type UnitInput } from "../core/unit-blocks.ts";
import { checkDoneMapsScenarios, validateUnits } from "../core/validate-units.ts";
import { decisionComment, type DecisionRecord } from "../decide/records.ts";
import type { Git } from "../engine/git.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { CachedForge } from "../forge/cache.ts";
import type { Issue } from "../forge/types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { type ClassifiedUnits, classifyUnits } from "./classify-units.ts";
import { livespecBaseKey } from "./change-start.ts";

const REMOTE = "origin";
const UNITS = "Units";
const BASE_KEY = "Base";

// --- step 1: reconcile the base ------------------------------------------------

/**
 * Finishes a previous run whose outcome was unknown: when the issue `Base` differs from the branch's
 * `livespecBase` config and is an ancestor of HEAD, the config takes the issue value. Returns whether it did.
 */
export async function reconcileBase(git: Git, branch: string, issueBase: string | undefined): Promise<boolean> {
	if (issueBase === undefined) return false;
	const key = livespecBaseKey(branch);
	if ((await git.configGet(key)) === issueBase) return false;
	let ancestor: boolean;
	try {
		ancestor = await git.isAncestor(issueBase, "HEAD");
	} catch {
		// An issue Base that is not a commit here is not repaired; the merge step reports the real state.
		return false;
	}
	if (!ancestor) return false;
	await git.configSet(key, issueBase);
	return true;
}

// --- step 2: classify ----------------------------------------------------------

/**
 * Assigns `U1…Un` in input order and runs the `tags` then `difficulty` decision per unit; nothing is
 * posted. A rule that rejects its facts (e.g. a non-kebab-case extra tag) is a refusal.
 */
export async function classifyPlan(units: UnitInput[], decisions: Pack["decisions"]): Promise<{ ok: true; plan: ClassifiedUnits } | { ok: false; message: string }> {
	try {
		return { ok: true, plan: await classifyUnits(units.map((input, i) => ({ id: `U${i + 1}`, input })), decisions) };
	} catch (error) {
		return { ok: false, message: `plan_units refused: ${messageOf(error)}; nothing was merged or written.` };
	}
}

// --- step 3: render and validate -----------------------------------------------

/** The `## Units` section content: every rendered block, separated by one blank line. */
export function renderUnitsSection(units: RenderableUnit[]): string {
	return units.map((u) => renderUnit(u).join("\n")).join("\n\n");
}

/** The body with the rendered units, or the LS-02 unit validator errors that refuse it. */
export function validatePlan(body: string, units: RenderableUnit[]): { ok: true; body: string } | { ok: false; message: string } {
	const next = replaceSection(body, UNITS, renderUnitsSection(units));
	const change = parseChange(next);
	const errors: Result[] = [...validateUnits(change), ...checkDoneMapsScenarios(change)].filter((r) => r.severity === "error");
	if (errors.length === 0) return { ok: true, body: next };
	return { ok: false, message: `plan_units refused: the units are invalid, so nothing was merged or written.\n${formatResults(errors)}` };
}

// --- step 4: merge the integration branch --------------------------------------

/** Fetches and merges `origin/<integration>`; a conflict is aborted. The new Base is the merged integration commit. */
export async function mergeIntegration(git: Git, integration: string): Promise<{ ok: true; base: string } | { ok: false; message: string }> {
	const ref = `${REMOTE}/${integration}`;
	await git.fetch(REMOTE, integration);
	const base = await git.revParse(ref);
	if ((await git.merge(ref)) === "conflict") {
		await git.mergeAbort();
		return { ok: false, message: `plan_units refused: merging ${ref} conflicts, so the merge was aborted and nothing was written. Merge ${ref} and resolve the conflict, then rerun plan_units.` };
	}
	return { ok: true, base };
}

// --- step 5: post the decision records -----------------------------------------

/**
 * One `decision` comment per unit and point, before the body write (records are keyed by unit digest).
 * A failure is a refusal: the merge commit stays, the body and Base are untouched, and a rerun posts again.
 */
export async function postDecisionRecords(forge: CachedForge, n: number, records: DecisionRecord[]): Promise<string | undefined> {
	try {
		for (const r of records) await forge.createComment(n, decisionComment(r));
		return undefined;
	} catch (error) {
		return `plan_units refused: posting the decision records to #${n} failed (${untrusted(messageOf(error))}). The units and Base were not written; the merge commit stays on the branch. Rerun plan_units to finish.`;
	}
}

// --- step 6: write Units and Base ----------------------------------------------

export type WriteOutcome = { kind: "written" } | { kind: "conflict"; changed: string[] } | { kind: "thrown"; error: unknown };

/** The planned body: the validated units body with `Base` set to the merged integration commit. */
export function plannedBody(unitsBody: string, base: string): string {
	return setHeaderLine(unitsBody, BASE_KEY, base);
}

/** One version-checked body write; a thrown error is returned as an unknown outcome. */
export async function writePlan(forge: CachedForge, issue: Issue, body: string): Promise<WriteOutcome> {
	try {
		const r = await forge.updateIssueBody(issue.number, body, issue.version);
		return r.status === "written" ? { kind: "written" } : { kind: "conflict", changed: r.changed };
	} catch (error) {
		return { kind: "thrown", error };
	}
}

/** Whether a fresh read shows both the new `Base` and exactly the planned `## Units`; a stale or failed read cannot. */
export async function planOnForge(forge: CachedForge, n: number, body: string, base: string): Promise<boolean> {
	try {
		const issue = await forge.getIssue(n);
		if (issue.stale) return false;
		return parseChange(issue.body).header.base === base && sectionText(issue.body, UNITS) === sectionText(body, UNITS);
	} catch {
		return false;
	}
}

// --- step 7: set the branch's livespecBase -------------------------------------

/** Runs only after the issue is known to record `base`. */
export async function setLivespecBase(git: Git, branch: string, base: string): Promise<void> {
	await git.configSet(livespecBaseKey(branch), base);
}
