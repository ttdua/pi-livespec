// Menu text for the in-session adapter: select entries and the title with the briefing. Pure.
// The title is plain text; agent text is only neutralised, never markdown-escaped.

import type { ApprovalRequest, Briefing } from "./approver.ts";
import { neutralise } from "./briefing.ts";

/** One select entry: the label shown to the human and the value it stands for. */
export type MenuEntry<T> = readonly [label: string, value: T];

const RECOMMENDED = " (Recommended)";

export type MenuChoice<T> = { id: string; label: string; description?: string; value: T };

/** Labels of the question entries; gate entries keep the labels `gateChoices` gives them. */
export const ENTRY_LABELS = { own: "write my own answer", later: "answer later (non-blocking)", answerNow: "answer now" } as const;

/** The recommended item first, the rest in order; an unknown or missing id changes nothing. */
export function orderRecommended<T extends { id: string }>(choices: T[], recommended?: string): T[] {
	return [...choices.filter((c) => c.id === recommended), ...choices.filter((c) => c.id !== recommended)];
}

/** `<label> — <description>`, the recommended entry first and marked; no raw ids are shown. */
export function menuEntries<T>(choices: MenuChoice<T>[], recommended?: string): MenuEntry<T>[] {
	return orderRecommended(choices, recommended).map((c) => {
		const text = c.description ? `${c.label} — ${c.description}` : c.label;
		return [c.id === recommended ? text + RECOMMENDED : text, c.value] as const;
	});
}

export const BRIEFING_HEADING: Record<Briefing["author"], string> = {
	agent: "Agent recommendation (agent-authored, advisory)",
	rule: "Livespec rule recommendation",
};

/** The briefing lines, not neutralised; `recommended` is shown by the label of the choice it names. */
export function briefingLines(b: Briefing, recommendedLabel?: string): string[] {
	const lines = [BRIEFING_HEADING[b.author], b.summary];
	if (b.watch && b.watch.length > 0) lines.push("Watch:", ...b.watch.map((w) => `- ${w}`));
	if (b.recommended !== undefined) lines.push(`Recommended: ${recommendedLabel ?? b.recommended}`);
	if (b.rationale !== undefined) lines.push(`Why: ${b.rationale}`);
	return lines;
}

/** The facts (`summary`), a blank line, then the briefing; just the summary without a briefing. */
export function titleWithBriefing(r: ApprovalRequest, recommendedLabel?: string): string {
	return r.briefing ? `${r.summary}\n\n${neutralise(briefingLines(r.briefing, recommendedLabel).join("\n"))}` : r.summary;
}
