// The resume card shown at session start as a UI-only custom entry. Custom
// entries never reach the LLM; the model sees the card only through `context`.
// The renderer is a minimal TUI component, so no TUI package is imported.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RESUME_ENTRY_TYPE = "livespec-resume";
export type ResumeEntry = { text: string };

const MIN_WIDTH = 1;

/** Hard-wraps each line to `width` columns (the card is plain text without ANSI codes). */
export function wrapLines(text: string, width: number): string[] {
	const columns = Math.max(MIN_WIDTH, Math.floor(width));
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const chars = [...line];
		if (chars.length === 0) out.push("");
		for (let i = 0; i < chars.length; i += columns) out.push(chars.slice(i, i + columns).join(""));
	}
	return out;
}

export function registerResumeRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<ResumeEntry>(RESUME_ENTRY_TYPE, (entry) => {
		const text = entry.data?.text ?? "";
		return { render: (width: number) => wrapLines(text, width), invalidate: () => {} };
	});
}

export function appendResumeEntry(pi: ExtensionAPI, text: string): void {
	const entry: ResumeEntry = { text };
	pi.appendEntry(RESUME_ENTRY_TYPE, entry);
}
