// What the parent reads after a subagent run: the recorded result with its reason, evidence and named sources, a question, or the next step.

import { discoveredDeps } from "../engine/deps-facts.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import type { DispatchOutcome } from "../subagents/dispatch.ts";
import { isMissingPrerequisite } from "../subagents/result.ts";
import type { SubagentResult } from "../subagents/roles.ts";
import type { Packet } from "../subagents/source-types.ts";
import { packetText } from "./subagent-request.ts";
import { argsOf, type Target } from "./subagent-target.ts";

/** The inline path: the same packet, done in this session, finished with `subagent_record`. */
export function inlineText(t: Target, reason: string, packet: Packet): string {
	const args = argsOf(t);
	return `${t.role} runs inline: ${reason}. Do the work in this session with the packet below, then record the result with subagent_record ${args} (same result shape a child submits).\n\n${packetText(packet)}`;
}

const STUCK_HINT = (t: Target): string => `\nThe NEEDS_CONTEXT cap is reached: send a stuck report with spec_stuck for ${t.unit ?? "the change"} instead of dispatching again.`;

const STATUS_HINT: Partial<Record<SubagentResult["status"], string>> = {
	NEEDS_CONTEXT: "\nThe child needs more context: add the sources it names (answer a question, amend the unit) and dispatch again; this is not a failed attempt.",
	BLOCKED: "\nThe child is blocked: read its reason and evidence, then send a stuck report with spec_stuck.",
};

/** What the callers know about the `discovered_deps` cap: while it blocks, a missing prerequisite goes to `spec_stuck`. */
export type OutcomeOptions = { depsCapped?: boolean };

/** The options of `state` under `pack`: whether the `discovered_deps` cap blocks now. */
export const outcomeOptions = (state: Pick<ChangeState, "marked">, pack: Pick<Pack, "loops">): OutcomeOptions => ({ depsCapped: discoveredDeps(state.marked, pack.loops.discovered_deps).blocking });

/** The next step of a missing prerequisite: `new_dependency` with the child's evidence, or `spec_stuck` at the cap. Not a failed attempt. */
function prerequisiteHint(t: Target, r: SubagentResult | undefined, o: OutcomeOptions & { evidenceShown?: boolean }): string {
	const unit = t.unit ?? "the change";
	if (o.depsCapped === true) return `\nA prerequisite is missing, but discovered_deps reached its cap: send a stuck report with spec_stuck for ${unit}, so the human can send the work back to the initiative's shape. This is not a failed attempt.`;
	const args = t.unit === undefined ? "" : ` ${t.unit}`;
	const evidence = o.evidenceShown === true ? "the child's evidence above" : `the child's evidence (${untrusted(r?.evidence ?? "")})`;
	return `\nA prerequisite is missing: run new_dependency${args} with ${evidence} and a draft for each option. This is not a failed attempt.`;
}

/** The recorded result's lines; every child-authored part is wrapped as untrusted. */
function resultLines(t: Target, r: SubagentResult, named: string[] | undefined): string[] {
	return [
		`${argsOf(t)} settled with ${r.status} and was recorded.`,
		`Notes: ${untrusted(r.notes)}`,
		...(r.reason === undefined ? [] : [`Reason: ${untrusted(r.reason)}`]),
		...(r.evidence === undefined ? [] : [`Evidence: ${untrusted(r.evidence)}`]),
		...(named === undefined ? [] : [`Sources named: ${named.length === 0 ? "none" : untrusted(named.join(", "))}`]),
		`Commits: ${(r.commits ?? []).length === 0 ? "none" : untrusted((r.commits ?? []).join(", "))}`,
		`Discoveries: ${r.discoveries.length === 0 ? "none" : untrusted(r.discoveries.join("; "))}`,
		...(r.findings === undefined ? [] : [`Findings: ${r.findings.length}`]),
	];
}

/** The recorded result and what to do next; `capped` turns NEEDS_CONTEXT into a stuck hint, a missing prerequisite names `new_dependency`. */
export function resultText(t: Target, r: SubagentResult, named: string[] | undefined, capped = false, o: OutcomeOptions = {}): string {
	const hint = isMissingPrerequisite(r) ? prerequisiteHint(t, r, o) : capped && r.status === "NEEDS_CONTEXT" ? STUCK_HINT(t) : (STATUS_HINT[r.status] ?? "");
	return resultLines(t, r, named).join("\n") + hint;
}

/** A stuck missing prerequisite: the recorded result's lines (evidence once), then the hint, which names the evidence only when no result shows it. */
function prerequisiteStuckText(t: Target, r: SubagentResult | undefined, o: OutcomeOptions): string {
	const head = `${argsOf(t)} settled with BLOCKED (missing-prerequisite) and was recorded.`;
	if (r === undefined) return head + prerequisiteHint(t, r, o);
	return [head, ...resultLines(t, r, undefined).slice(1)].join("\n") + prerequisiteHint(t, r, { ...o, evidenceShown: true });
}

/** What the parent reads after a dispatch: the recorded result, the child's question, or the next step. */
export function outcomeText(t: Target, outcome: DispatchOutcome, o: OutcomeOptions = {}): string {
	switch (outcome.kind) {
		case "result":
			return resultText(t, outcome.result, outcome.sourcesNamed, false, o);
		case "question":
			return `Child ${outcome.id} asks: ${untrusted(outcome.text)}\nAnswer it with subagent_answer ${outcome.id} "<answer>". If only the user can decide (scope, a requirement, a public contract or an acceptance criterion), raise it with spec_question first and answer the child with the user's answer.`;
		case "inline":
			return inlineText(t, outcome.reason, outcome.packet);
		case "sequential":
			return `${outcome.reason}. The lane is closed and removed; run ${t.unit} in the change worktree.`;
		case "blocked":
			return `${argsOf(t)} is BLOCKED: ${outcome.reason}. Send a stuck report with spec_stuck.`;
		case "cancelled":
			return `${argsOf(t)} was cancelled: ${outcome.reason}. Dispatch it again when ready.`;
		case "stuck":
			if (outcome.prerequisite === true) return prerequisiteStuckText(t, outcome.result, o);
			return `${argsOf(t)} needs a decision: ${outcome.reason}. Send a stuck report with spec_stuck for ${t.unit ?? "the change"}.${outcome.result ? `\n${resultLines(t, outcome.result, undefined).join("\n")}` : ""}`;
	}
}
