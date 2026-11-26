// The choices a gate, amendment, stuck or rule request offers, with livespec-written
// descriptions of the built-in actions (design D6). The single source of offered ids
// for briefing validation and both adapters. Pure.

import type { ApprovalRequest, RequestOption } from "./approver.ts";
import { failingWaivableOf, WAIVE } from "./waive-rule.ts";

export type ChoiceKind = "gate" | "amend" | "choice";
export type GateChoice = { id: string; label: string; description: string; command: string };

const APPROVE = "approve";
const CHANGES = "changes";
const DISMISS = "dismiss";

const APPROVE_BY_TARGET: Record<string, string> = {
	define: "Accept the spec; the change moves to plan.",
	plan: "Lock the unit digests; the change moves to build.",
	ship: "Accept the ship packet; change_ship can then run.",
};
const APPROVE_NAMED = "Accept; the gate's effects are applied.";

const BUILT_INS: Record<string, Omit<GateChoice, "description"> & { description?: string }> = {
	[APPROVE]: { id: APPROVE, label: "approve", command: "/livespec approve [notes]" },
	[CHANGES]: { id: CHANGES, label: "request changes", description: "Send the request back with notes; nothing is approved.", command: "/livespec changes <notes>" },
	[DISMISS]: { id: DISMISS, label: "dismiss", description: "Close the request without approving it.", command: "/livespec dismiss [notes]" },
};

/** Option ids in order, `waive` first and every id once. */
function optionIds(options: RequestOption[]): string[] {
	const ids = new Set(options.some((o) => o.id === WAIVE) ? [WAIVE] : []);
	for (const o of options) ids.add(o.id);
	return [...ids];
}

/** The ids a request offers: built-ins for gates (no `approve` while a waivable check fails) and amendments, then options. */
export function offeredChoiceIds(i: { kind: ChoiceKind; options: RequestOption[]; failingWaivable?: string[] }): string[] {
	if (i.kind === "choice") return optionIds(i.options);
	const approve = (i.failingWaivable ?? []).length > 0 ? [] : [APPROVE];
	const builtIns = [...approve, CHANGES, DISMISS];
	return i.kind === "amend" ? builtIns : [...builtIns, ...optionIds(i.options)];
}

/** How `r` is answered: built-in actions for gates and amendments, options for stuck and rule requests. */
export function choiceKindOf(r: Pick<ApprovalRequest, "kind" | "subject">): ChoiceKind {
	if (r.subject.startsWith("amend:")) return "amend";
	return r.kind === "gate" ? "gate" : "choice";
}

function approveDescription(subject: string): string {
	const target = subject.startsWith("gate:") ? subject.slice("gate:".length) : "";
	return APPROVE_BY_TARGET[target] ?? APPROVE_NAMED;
}

function describe(id: string, r: ApprovalRequest, failing: string[]): GateChoice {
	if (id === APPROVE) return { ...BUILT_INS[APPROVE]!, description: approveDescription(r.subject) };
	const builtIn = BUILT_INS[id];
	if (builtIn?.description !== undefined) return { ...builtIn, description: builtIn.description };
	const option = (r.options ?? []).find((o) => o.id === id);
	const description = id === WAIVE ? `Approve and waive the failing checks: ${failing.join(", ")}.` : (option?.description ?? "");
	return { id, label: option?.label ?? id, description, command: `/livespec choose ${id} [notes]` };
}

/** The choices `r` offers in `offeredChoiceIds` order; a question offers none (it is answered with text). */
export function gateChoices(r: ApprovalRequest): GateChoice[] {
	if (r.kind === "question") return [];
	const failing = failingWaivableOf(r.record.snapshot);
	const ids = offeredChoiceIds({ kind: choiceKindOf(r), options: r.options ?? [], failingWaivable: failing });
	return ids.map((id) => describe(id, r, failing));
}
