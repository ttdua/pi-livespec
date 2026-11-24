// Scout confirmation of the heuristic drift items: one `scout` child judges them in a temporary
// worktree of the audited commit. No forge write: the run has no change issue, so its record is a sink.

import { createHash } from "node:crypto";
import { messageOf } from "../core/messages.ts";
import type { Git } from "../engine/git.ts";
import { withTempWorktree, type WorktreeFailure } from "../evidence/worktree.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { type DispatchDeps, type DispatchOutcome, runDispatch } from "../subagents/dispatch.ts";
import type { SubagentsServiceLike } from "../subagents/executor.ts";
import type { EventsLike } from "../subagents/launch.ts";
import { protocolText } from "../subagents/protocol.ts";
import type { ScoutVerdict } from "../subagents/roles.ts";
import type { Packet } from "../subagents/source-types.ts";
import type { DriftItem, DriftType } from "./items.ts";

export type ConfirmDeps = { service?: SubagentsServiceLike; events: EventsLike; git: Git; root: string; exclusions: string[]; signal?: AbortSignal };

export type Refuted = { key: string; reason: string };
export type Confirmation = { kept: DriftItem[]; refuted: Refuted[]; note?: string };

/** The scout's verdicts by item key, or why it gave none. */
type Judgement = { verdicts: Map<string, ScoutVerdict>; note?: string };

const HEURISTIC: ReadonlySet<DriftType> = new Set(["scenario-untested", "removed-reference"]);
export const AUDIT_CHANGE = "audit";
const UNCONFIRMED = "they are reported unconfirmed";

const isHeuristic = (item: DriftItem): boolean => HEURISTIC.has(item.type);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Sends the heuristic items to the scout; refuted ones are dropped, unjudged ones kept with `confirmed: false`. */
export async function confirmItems(items: DriftItem[], commit: string, deps: ConfirmDeps): Promise<Confirmation> {
	const candidates = items.filter(isHeuristic);
	if (candidates.length === 0) return { kept: items, refuted: [] };
	const judged = await judge(candidates, commit, deps);
	return applyVerdicts(items, judged);
}

const unjudged = (note: string): Judgement => ({ verdicts: new Map(), note: `${note}; ${UNCONFIRMED}` });

async function judge(candidates: DriftItem[], commit: string, deps: ConfirmDeps): Promise<Judgement> {
	const service = deps.service;
	if (service === undefined) return unjudged("no capable executor is present, so the scout did not run");
	const text = await packetText(candidates, commit, deps.git);
	try {
		const outcome = await inSnapshot(deps, commit, (dir) => dispatchScout({ ...deps, service }, packetOf(text, dir)));
		return "invalid" in outcome ? unjudged(`the scout worktree could not be prepared (${outcome.invalid})`) : judgementOf(outcome, candidates);
	} catch (error) {
		return unjudged(`the scout worktree or launch failed (${untrusted(messageOf(error))})`);
	}
}

/** Runs `fn` in a temporary worktree at the audited commit, removed afterwards; no `verify.setup` runs there. */
function inSnapshot<T>(deps: ConfirmDeps, commit: string, fn: (dir: string) => Promise<T>): Promise<T | WorktreeFailure> {
	const run = { timeoutS: 0, guard: () => undefined, tokens: [], tailBytes: 0, ...(deps.signal === undefined ? {} : { signal: deps.signal }) };
	return withTempWorktree(deps.git, deps.root, commit, { run }, fn);
}

/** The packet: protocol layer, the audited commit, and a task listing each candidate with its spec text as untrusted data. */
async function packetText(candidates: DriftItem[], commit: string, git: Pick<Git, "showFile">): Promise<string> {
	const listing = candidates.map((i) => `- ${untrusted(i.key)}\n  Evidence: ${untrusted(i.evidence)}`).join("\n");
	const specs = await specTexts(candidates, commit, git);
	return [
		protocolText(),
		"# Task: confirm drift items",
		`Audited commit: ${commit}`,
		"Your working directory is a checkout of the audited commit. Judge only that tree; change nothing.",
		"For each item below, decide whether the drift is real (`confirmed`) or the scenario's test or the reference exists under another name (`refuted`).",
		"Return one entry per item in `verdicts`: `{ key, verdict: confirmed | refuted, reason }`, with the key exactly as listed.",
		"## Items",
		listing,
		...specs,
	].join("\n\n");
}

/** The living spec of each capability the candidates name, read at the audited commit. */
async function specTexts(candidates: DriftItem[], commit: string, git: Pick<Git, "showFile">): Promise<string[]> {
	const capabilities = [...new Set(candidates.flatMap((i) => (i.capability === undefined ? [] : [i.capability])))];
	const out: string[] = [];
	for (const capability of capabilities) {
		const path = `specs/${capability}/spec.md`;
		const text = await git.showFile(commit, path);
		if (text !== undefined) out.push(`## Spec ${path}\n\n${untrusted(text)}`);
	}
	return out;
}

const packetOf = (text: string, cwd: string): Packet => ({ text, hash: sha256(text), sources: [], skillPaths: [], cwd, seen: [] });

/** One scout dispatch whose record goes nowhere: the audit has no change issue. */
function dispatchScout(deps: ConfirmDeps & { service: SubagentsServiceLike }, packet: Packet): Promise<DispatchOutcome> {
	const dispatch: DispatchDeps = {
		service: deps.service,
		events: deps.events,
		onOverride: () => undefined,
		post: async () => undefined,
		headOf: async () => "",
		reachable: async () => [],
		...(deps.signal === undefined ? {} : { signal: deps.signal }),
	};
	return runDispatch(dispatch, {
		role: "scout", change: AUDIT_CHANGE, difficulty: "low", failedAttempts: 0, attempt: 1, round: 1, needsContext: 0,
		packet, exclusions: deps.exclusions,
	});
}

/** Why a dispatch ended without a result. The audit never runs the scout inline, so the dispatch's inline advice is not repeated. */
function noResultReason(outcome: Exclude<DispatchOutcome, { kind: "result" }>): string {
	switch (outcome.kind) {
		case "inline":
		case "sequential":
			return "the scout could not be launched as requested (agent disabled, launch refused or launch mismatch)";
		case "question":
			return "the scout asked a question instead of returning verdicts";
		default:
			return `the scout run ended ${outcome.kind}: ${outcome.reason}`;
	}
}

function judgementOf(outcome: DispatchOutcome, candidates: DriftItem[]): Judgement {
	if (outcome.kind !== "result") {
		return unjudged(noResultReason(outcome));
	}
	const keys = new Set(candidates.map((i) => i.key));
	const verdicts = new Map((outcome.result.verdicts ?? []).filter((v) => keys.has(v.key)).map((v) => [v.key, v]));
	const missing = candidates.length - verdicts.size;
	return missing === 0 ? { verdicts } : { verdicts, note: `the scout returned no verdict for ${missing} item(s); they are reported unconfirmed` };
}

function applyVerdicts(items: DriftItem[], judged: Judgement): Confirmation {
	const kept: DriftItem[] = [];
	const refuted: Refuted[] = [];
	for (const item of items) {
		if (!isHeuristic(item)) {
			kept.push(item);
			continue;
		}
		const verdict = judged.verdicts.get(item.key);
		if (verdict?.verdict === "refuted") refuted.push({ key: item.key, reason: verdict.reason });
		else kept.push({ ...item, confirmed: verdict?.verdict === "confirmed" });
	}
	return { kept, refuted, ...(judged.note === undefined ? {} : { note: judged.note }) };
}
