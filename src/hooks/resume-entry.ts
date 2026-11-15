// The resume card shown at session start as a UI-only custom entry. Custom
// entries never reach the LLM; the model sees the card only through `context`.
// `@earendil-works/pi-tui` is a host-provided import (pi maps it to its own
// copy), so it is not a package dependency; its `Text` wraps by visible width.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const RESUME_ENTRY_TYPE = "livespec-resume";
export type ResumeEntry = { text: string };

const PADDING_X = 0;
const PADDING_Y = 0;

export function registerResumeRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<ResumeEntry>(RESUME_ENTRY_TYPE, (entry) => new Text(entry.data?.text ?? "", PADDING_X, PADDING_Y));
}

export function appendResumeEntry(pi: ExtensionAPI, text: string): void {
	const entry: ResumeEntry = { text };
	pi.appendEntry(RESUME_ENTRY_TYPE, entry);
}
