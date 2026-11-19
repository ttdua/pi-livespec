// What the parent reads after a subagent run: the recorded result with its reason, evidence and named sources, a question, or the next step.

import type { DispatchOutcome } from "../subagents/dispatch.ts";
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

/** The recorded result, with the child's reason and evidence and the source ids it named; `capped` turns NEEDS_CONTEXT into a stuck hint. */
export function resultText(t: Target, r: SubagentResult, named: string[] | undefined, capped = false): string {
	const lines = [
		`${argsOf(t)} settled with ${r.status} and was recorded.`,
		`Notes: ${r.notes}`,
		...(r.reason === undefined ? [] : [`Reason: ${r.reason}`]),
		...(r.evidence === undefined ? [] : [`Evidence: ${r.evidence}`]),
		...(named === undefined ? [] : [`Sources named: ${named.length === 0 ? "none" : named.join(", ")}`]),
		`Commits: ${(r.commits ?? []).join(", ") || "none"}`,
		`Discoveries: ${r.discoveries.join("; ") || "none"}`,
		...(r.findings === undefined ? [] : [`Findings: ${r.findings.length}`]),
	];
	const hint = capped && r.status === "NEEDS_CONTEXT" ? STUCK_HINT(t) : (STATUS_HINT[r.status] ?? "");
	return lines.join("\n") + hint;
}

/** What the parent reads after a dispatch: the recorded result, the child's question, or the next step. */
export function outcomeText(t: Target, outcome: DispatchOutcome): string {
	switch (outcome.kind) {
		case "result":
			return resultText(t, outcome.result, outcome.sourcesNamed);
		case "question":
			return `Child ${outcome.id} asks: ${outcome.text}\nAnswer it with subagent_answer ${outcome.id} "<answer>". If only the user can decide (scope, a requirement, a public contract or an acceptance criterion), raise it with spec_question first and answer the child with the user's answer.`;
		case "inline":
			return inlineText(t, outcome.reason, outcome.packet);
		case "sequential":
			return `${outcome.reason}. Close the lane and run ${t.unit} in the change worktree.`;
		case "blocked":
			return `${argsOf(t)} is BLOCKED: ${outcome.reason}. Send a stuck report with spec_stuck.`;
		case "stuck":
			return `${argsOf(t)} needs a decision: ${outcome.reason}. Send a stuck report with spec_stuck for ${t.unit ?? "the change"}.`;
	}
}
