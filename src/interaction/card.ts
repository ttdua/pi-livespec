// The `approvals` card section (design D13): pending and applying approver
// requests with subject and adapter, frozen and stale units, the open stuck
// report, and command comments the last poll ignored. Pure; forge text is
// wrapped as untrusted.

import type { NextStep } from "../engine/state-types.ts";
import { type CardSection, registerCardSection, untrusted } from "../hooks/phase-card.ts";

const TOKEN = /^[A-Za-z0-9:._-]+$/;

function listLines(title: string, items: string[]): string[] {
	return items.length === 0 ? [] : [`${title}:`, ...items.map((item) => `- ${item}`)];
}

function inlineLine(title: string, items: string[]): string[] {
	return items.length === 0 ? [] : [`${title}: ${items.join(", ")}`];
}

/** Subjects and ids come from own comments, but are shown plain only when they look like ours. */
function plain(text: string): string {
	return TOKEN.test(text) ? text : untrusted(text);
}

/** One pending or applying request, shared with the next-step text. */
export function pendingText(r: NextStep["pending"][number]): string {
	return `${plain(r.subject)} (${plain(r.id)}) via ${r.adapter}, ${plain(r.mode)}`;
}

export const approvalsSection: CardSection = (i) => {
	if (i.kind !== "change") return undefined;
	const { step, state } = i;
	const lines = [
		...listLines("Pending approvals", step.pending.map(pendingText)),
		...inlineLine("Frozen units", step.frozenUnits),
		...inlineLine("Stale units", step.staleUnits),
		...(step.stuckOpen === undefined ? [] : [`Stuck report: ${plain(step.stuckOpen)} waits for the human's choice`]),
		...listLines("Ignored commands", state.commandWarnings.map(untrusted)),
	];
	return lines.length === 0 ? undefined : lines.join("\n");
};

registerCardSection("approvals", approvalsSection);
