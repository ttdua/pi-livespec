// The `behavior-change` decision point (durable-doc-checks "Behavior conclusion rule, precedence and check"): the
// facts built from the change diff and the living specs' `paths`, the never-asking rule, the effective conclusion
// per item and per capability, and the check's results over the records. Pure: git and the work tree are read in
// `behavior-check.ts`; the check never asks, `spec_gate` takes the agent's conclusions through its `behavior` parameter.

import { createHash } from "node:crypto";
import { isMap } from "yaml";
import { matchGlob } from "../core/glob.ts";
import type { Result } from "../core/result.ts";
import { isBacked } from "../decide/answered.ts";
import { type DecisionRecord, decisionComment, sameFacts, validDecisions } from "../decide/records.ts";
import type { RuleFn, RuleSchema } from "../decide/registry.ts";
import { checkAllowedKeys } from "../decide/rules/schema-util.ts";
import type { MarkedComment } from "../forge/markers.ts";
import type { AppendInput } from "../ledger/entry.ts";
import { openRequestFor, readRequests } from "../interaction/requests.ts";

import { BEHAVIOR_POINT } from "../decide/points.ts";

export { BEHAVIOR_POINT };

/** One capability whose code changed while its spec did not; `files` sorted. */
export type BehaviorItem = { capability: string; files: string[] };

export type BehaviorOutcome = "unchanged" | "changed";
export type BehaviorConclusionInput = { capability: string; outcome: BehaviorOutcome; rationale: string };
export type BehaviorConclusion = { outcome: BehaviorOutcome; source: "agent" | "human"; reason: string; files: string[]; ref: string };

type SpecPaths = { capability: string; paths: string[] };
type Entry = { record: DecisionRecord; ref: string };

const SPECS_PATH = "specs/";
const CODE = "behavior-change";

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

/** A human `changed` conclusion: no agent record replaces it. */
const isHumanChange = (r: DecisionRecord): boolean => r.source === "human" && r.outcome === "changed";

const isConclusionOutcome = (v: unknown): v is BehaviorOutcome => v === "unchanged" || v === "changed";

const isConclusion = (r: DecisionRecord, capability: string | undefined): boolean =>
	r.point === BEHAVIOR_POINT && (capability === undefined || r.subject === capability) && (r.source === "agent" || r.source === "human") && r.proposal !== true && isConclusionOutcome(r.outcome);

/**
 * Valid `behavior-change` conclusions of `capability` (all when omitted), in merged order; proposals, rules and
 * human ledger entries without their forge answer (`isBacked`) left out.
 */
function conclusionEntries(marked: MarkedComment[], capability?: string): Entry[] {
	return marked.flatMap((m) => {
		const record = validDecisions([m])[0];
		return record !== undefined && isConclusion(record, capability) && isBacked(marked, m, record) ? [{ record, ref: m.ref }] : [];
	});
}

/** The winner of `entries`: the latest one, except that an agent record never replaces a human `changed`. */
function fold(entries: Entry[]): Entry | undefined {
	let winner: Entry | undefined;
	for (const e of entries) {
		if (winner === undefined || !isHumanChange(winner.record) || e.record.source === "human") winner = e;
	}
	return winner;
}

const sharesFile = (files: string[] | undefined, item: BehaviorItem): boolean => (files ?? []).some((f) => item.files.includes(f));

/** A record for the item's digest and facts, or a human `changed` that shares one of its files. */
function isCandidate(e: Entry, item: BehaviorItem): boolean {
	const { record } = e;
	if (record.digest === behaviorDigest(item.files) && sameFacts(record, item)) return true;
	return isHumanChange(record) && sharesFile(record.files, item);
}

function toConclusion(e: Entry): BehaviorConclusion {
	const { record, ref } = e;
	return { outcome: record.outcome as BehaviorOutcome, source: record.source as BehaviorConclusion["source"], reason: record.reason, files: record.files ?? [], ref };
}

/** The item's effective conclusion: the winner among its candidates, or undefined when none applies. */
export function effectiveConclusion(marked: MarkedComment[], item: BehaviorItem): BehaviorConclusion | undefined {
	const winner = fold(conclusionEntries(marked, item.capability).filter((e) => isCandidate(e, item)));
	return winner === undefined ? undefined : toConclusion(winner);
}

/** Per capability, the winning conclusion over all its records, digests and files ignored. */
export function latestConclusions(marked: MarkedComment[]): Map<string, BehaviorConclusion> {
	const byCapability = new Map<string, Entry[]>();
	for (const e of conclusionEntries(marked)) {
		const entries = byCapability.get(e.record.subject) ?? [];
		entries.push(e);
		byCapability.set(e.record.subject, entries);
	}
	const latest = new Map<string, BehaviorConclusion>();
	for (const [capability, entries] of byCapability) {
		const winner = fold(entries);
		if (winner !== undefined) latest.set(capability, toConclusion(winner));
	}
	return latest;
}

/** An agent conclusion to record. */
export type ConclusionInput = { outcome: BehaviorOutcome; reason: string };

/** The agent `decision` ledger entry input of a conclusion on `item`: digest and files of the item, facts as the item. */
export function behaviorConclusionComment(item: BehaviorItem, c: ConclusionInput): AppendInput {
	return decisionComment({
		point: BEHAVIOR_POINT,
		subject: item.capability,
		digest: behaviorDigest(item.files),
		source: "agent",
		outcome: c.outcome,
		reason: c.reason,
		facts: item,
		files: item.files,
	});
}

/** The rule never asks: the conclusion comes from the agent's `behavior` parameter, so the outcome is null. */
export const behaviorChangeRule: RuleFn = () => ({ outcome: null, reason: "concluded by the agent through spec_gate's behavior parameter" });

export const behaviorChangeSchema: RuleSchema = {
	validate(node, report) {
		if (isMap(node)) checkAllowedKeys(node, ["mode"], "decisions.behavior-change", report);
	},
};

export const behaviorSubject = (capability: string): `decide:${string}` => `decide:${BEHAVIOR_POINT}.${capability}`;

/** The refusal while a legacy `decide:behavior-change.<capability>` request is open for one of the items; undefined otherwise. */
export function legacyRequestRefusal(items: BehaviorItem[], marked: MarkedComment[]): string | undefined {
	const requests = readRequests(marked);
	for (const item of items) {
		const subject = behaviorSubject(item.capability);
		const open = openRequestFor(requests, subject);
		if (open !== undefined) return `spec_gate refused: request ${open} for ${subject} from before the behavior parameter is still open: answer or dismiss it first (/livespec choose or /livespec dismiss); nothing was written.`;
	}
	return undefined;
}

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
	const conclusion = effectiveConclusion(marked, item);
	const file = specFileOf(item.capability);
	if (conclusion?.outcome === "changed") return error(file, `the behavior of ${item.capability} changed (${conclusion.source} conclusion): update ${file}`);
	if (conclusion !== undefined) return undefined;
	const open = openRequestFor(requests, behaviorSubject(item.capability));
	const legacy = open === undefined ? "" : `; ${behaviorSubject(item.capability)} (${open}) is an open request from before this rule`;
	return error(file, `${item.capability} code changed (${item.files.join(", ")}) without ${file}: run spec_gate ${phase ?? "<phase>"} with a behavior parameter to conclude whether its behavior changed${legacy}`);
}

const error = (file: string, message: string): Result => ({ code: CODE, severity: "error", file, message });
