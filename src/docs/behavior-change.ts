// The `behavior-change` decision point (durable-doc-checks "Behavior change …", design D4): the facts built from
// the change diff and the living specs' `paths`, the always-asking rule, the latest human record per capability,
// and the check that reads the records. The check never asks; `spec_gate` asks (see `behavior-ask.ts`).

import { createHash } from "node:crypto";
import { isMap } from "yaml";
import { matchGlob } from "../core/glob.ts";
import type { Result } from "../core/result.ts";
import { type DecisionRecord, reusableAnswer } from "../decide/records.ts";
import type { RuleFn, RuleSchema } from "../decide/registry.ts";
import { checkAllowedKeys } from "../decide/rules/schema-util.ts";
import type { CheckFn, CheckGit } from "../engine/registry.ts";
import type { MarkedComment } from "../forge/markers.ts";
import { openRequestFor, readRequests } from "../interaction/requests.ts";
import { livingSpecs } from "../ship/context.ts";

export const BEHAVIOR_POINT = "behavior-change";

/** One capability whose code changed while its spec did not; `files` sorted. */
export type BehaviorItem = { capability: string; files: string[] };

type SpecPaths = { capability: string; paths: string[] };

const SPECS_PATH = "specs/";
const CODE = "behavior-change";

export const BEHAVIOR_OPTIONS = [
	{ id: "unchanged", label: "Behavior did not change" },
	{ id: "changed", label: "Behavior changed; the spec must be updated" },
];

const specFileOf = (capability: string): string => `${SPECS_PATH}${capability}/spec.md`;

/** Per living spec whose `paths` match a changed non-`specs/` file, unless its `spec.md` is in the diff. */
export function behaviorFacts(diffFiles: string[], specs: SpecPaths[]): BehaviorItem[] {
	const changed = new Set(diffFiles);
	const code = diffFiles.filter((f) => !f.startsWith(SPECS_PATH));
	return specs
		.filter((s) => !changed.has(specFileOf(s.capability)))
		.map((s) => ({ capability: s.capability, files: code.filter((f) => s.paths.some((p) => matchGlob(p, f))).sort() }))
		.filter((item) => item.files.length > 0);
}

/** SHA-256 hex of the files joined by newlines. */
export function behaviorDigest(files: string[]): string {
	return createHash("sha256").update(files.join("\n")).digest("hex");
}

/** Per capability, the latest `behavior-change` record answered by a human that is not a proposal. */
export function latestBehaviorRecords(marked: MarkedComment[]): Map<string, DecisionRecord> {
	const latest = new Map<string, DecisionRecord>();
	for (const m of marked) {
		if (m.kind !== "decision" || !isBehaviorRecord(m.data)) continue;
		latest.set(m.data.subject, m.data);
	}
	return latest;
}

function isBehaviorRecord(data: unknown): data is DecisionRecord {
	if (typeof data !== "object" || data === null) return false;
	const r = data as Partial<DecisionRecord>;
	return r.point === BEHAVIOR_POINT && typeof r.subject === "string" && r.source === "human" && r.proposal !== true;
}

/** The rule always asks a human. */
export const behaviorChangeRule: RuleFn = (facts) => {
	const item = facts as BehaviorItem;
	return { ask: { summary: behaviorSummary(item), options: BEHAVIOR_OPTIONS } };
};

function behaviorSummary(item: BehaviorItem): string {
	return [
		`Did the behavior of ${item.capability} change?`,
		`The change edits code under its paths but not ${specFileOf(item.capability)}:`,
		...item.files.map((f) => `- ${f}`),
	].join("\n");
}

export const behaviorChangeSchema: RuleSchema = {
	validate(node, report) {
		if (isMap(node)) checkAllowedKeys(node, ["mode"], "decisions.behavior-change", report);
	},
};

/** The record that answers `item` (same digest and facts), if any. */
export function behaviorAnswer(marked: MarkedComment[], item: BehaviorItem): DecisionRecord | undefined {
	return reusableAnswer(marked, BEHAVIOR_POINT, item.capability, behaviorDigest(item.files), item);
}

export const behaviorSubject = (capability: string): `decide:${string}` => `decide:${BEHAVIOR_POINT}.${capability}`;

/** The check's results for the items: pure over the marked comments. */
export function behaviorResults(items: BehaviorItem[], marked: MarkedComment[], phase: string | undefined): Result[] {
	const requests = readRequests(marked);
	const results: Result[] = [];
	for (const item of items) {
		const result = itemResult(item, marked, requests, phase);
		if (result !== undefined) results.push(result);
	}
	return results;
}

function itemResult(item: BehaviorItem, marked: MarkedComment[], requests: ReturnType<typeof readRequests>, phase: string | undefined): Result | undefined {
	const record = behaviorAnswer(marked, item);
	const file = specFileOf(item.capability);
	if (record?.outcome === "changed") return error(file, `the behavior of ${item.capability} changed: update ${file}`);
	if (record !== undefined) return undefined;
	const open = openRequestFor(requests, behaviorSubject(item.capability));
	if (open !== undefined) return error(file, `${behaviorSubject(item.capability)} (${open}) waits for the human's answer on whether the behavior of ${item.capability} changed`);
	return error(file, `${item.capability} code changed (${item.files.join(", ")}) without ${file}: run spec_gate ${phase ?? "<phase>"}, which asks the human whether its behavior changed`);
}

const error = (file: string, message: string): Result => ({ code: CODE, severity: "error", file, message });

/** The behavior items of `git diff <Base>..HEAD` against the living specs of the work tree; none without a Base. */
export async function changeBehaviorItems(root: string, git: Pick<CheckGit, "diffNames">, base: string | undefined): Promise<BehaviorItem[]> {
	if (base === undefined) return [];
	return behaviorFacts(await git.diffNames(base, "HEAD", "."), await livingSpecs(root));
}

/** The `behavior-change` check: never asks, only reads the records. */
export const behaviorChangeCheck: CheckFn = async ({ root, change, git, marked, phase }) =>
	behaviorResults(await changeBehaviorItems(root, git, change.header.base), marked, phase);
