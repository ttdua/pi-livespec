// Menu text for the in-session adapter: select entries and the title with the briefing. Pure.
// The title is plain text; agent text is only neutralised, never markdown-escaped.

import type { ApprovalRequest, Briefing } from "./approver.ts";
import { neutralise } from "./briefing.ts";

/** One select entry: the label shown to the human and the value it stands for. */
export type MenuEntry<T> = readonly [label: string, value: T];

const RECOMMENDED = " (Recommended)";

export type MenuChoice<T> = { id: string; label: string; description?: string; value: T };

/** `<label> — <description>`, the recommended entry first and marked; no raw ids are shown. */
export function menuEntries<T>(choices: MenuChoice<T>[], recommended?: string): MenuEntry<T>[] {
	const entries = choices.map((c) => {
		const text = c.description ? `${c.label} — ${c.description}` : c.label;
		return { id: c.id, entry: [c.id === recommended ? text + RECOMMENDED : text, c.value] as const };
	});
	const first = entries.filter((e) => e.id === recommended);
	const rest = entries.filter((e) => e.id !== recommended);
	return [...first, ...rest].map((e) => e.entry);
}

const HEADING: Record<Briefing["author"], string> = {
	agent: "Agent recommendation (agent-authored, advisory)",
	rule: "Livespec rule recommendation",
};

/** The briefing lines; `recommended` is shown by the label of the choice it names. */
function briefingBlock(b: Briefing, recommendedLabel: string | undefined): string {
	const lines = [HEADING[b.author], b.summary];
	if (b.watch && b.watch.length > 0) lines.push("Watch:", ...b.watch.map((w) => `- ${w}`));
	if (b.recommended !== undefined) lines.push(`Recommended: ${recommendedLabel ?? b.recommended}`);
	if (b.rationale !== undefined) lines.push(`Why: ${b.rationale}`);
	return neutralise(lines.join("\n"));
}

/** The facts (`summary`), a blank line, then the briefing; just the summary without a briefing. */
export function titleWithBriefing(r: ApprovalRequest, recommendedLabel?: string): string {
	return r.briefing ? `${r.summary}\n\n${briefingBlock(r.briefing, recommendedLabel)}` : r.summary;
}
