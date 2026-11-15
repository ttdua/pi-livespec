// The `approvals` card section (design D13): pending and applying approver
// requests with subject and adapter, frozen and stale units, the open stuck
// report, and command comments the last poll ignored. Pure; forge text is
// wrapped as untrusted.

import type { NextStep } from "../engine/state-types.ts";
import { type CardSection, registerCardSection, untrusted } from "../hooks/phase-card.ts";

const TOKEN = /^[A-Za-z0-9:._-]+$/;
const TOKEN_LIST_SEPARATOR = ", ";

function listLines(title: string, items: string[]): string[] {
	return items.length === 0 ? [] : [`${title}:`, ...items.map((item) => `- ${item}`)];
}

function inlineLine(title: string, items: string[]): string[] {
	return items.length === 0 ? [] : [`${title}: ${items.join(", ")}`];
}

/**
 * Subjects, ids and unit names read from comment data are arbitrary strings: they are shown plain only
 * when they are a single token (which cannot break out of the text), and wrapped as untrusted otherwise.
 */
export function token(text: string): string {
	return TOKEN.test(text) ? text : untrusted(text);
}

/** A comma-separated list of tokens, each wrapped as `token` does. */
export function tokenList(items: string[]): string[] {
	return items.length === 0 ? [] : [items.map(token).join(TOKEN_LIST_SEPARATOR)];
}

/** One pending or applying request, shared with the next-step text. */
export function pendingText(r: NextStep["pending"][number]): string {
	return `${token(r.subject)} (${token(r.id)}) via ${token(r.adapter)}, ${token(r.mode)}`;
}

export const approvalsSection: CardSection = (i) => {
	if (i.kind !== "change") return undefined;
	const { step, state } = i;
	const lines = [
		...listLines("Pending approvals", step.pending.map(pendingText)),
		...inlineLine("Frozen units", tokenList(step.frozenUnits)),
		...inlineLine("Stale units", tokenList(step.staleUnits)),
		...(step.stuckOpen === undefined ? [] : [`Stuck report: ${token(step.stuckOpen)} waits for the human's choice`]),
		...listLines("Ignored commands", state.commandWarnings.map(untrusted)),
	];
	return lines.length === 0 ? undefined : lines.join("\n");
};

registerCardSection("approvals", approvalsSection);
