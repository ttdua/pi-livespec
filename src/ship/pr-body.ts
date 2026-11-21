// The pull request title and body (design D5). Pure; closing keywords never survive (`Refs`, not `Closes`).

import { sectionText } from "../core/sections.ts";
import type { ChangeState } from "../engine/state-types.ts";

const CLOSING = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b(\s*:?\s*)((?:[\w.-]+\/[\w.-]+)?#\d+)/gi;

/** Rewrites closing keywords before an issue reference to `Refs <ref>`. */
export function neutralizeClosing(text: string): string {
	return text.replace(CLOSING, "Refs $4");
}

function firstParagraph(text: string | undefined): string {
	return (text ?? "").split(/\n\s*\n/)[0]?.trim() ?? "";
}

export function pullRequestBody(state: ChangeState, review: string): { title: string; body: string } {
	const body = state.change.lines.map((l) => l.text).join("\n");
	const units = state.change.units.map((u) => `- [${u.done ? "x" : " "}] ${u.id} — ${u.title}`);
	const parts = [neutralizeClosing(firstParagraph(sectionText(body, "Proposal")))];
	if (units.length > 0) parts.push(["## Units", ...units].join("\n"));
	const docs = sectionText(body, "Durable docs");
	if (docs !== undefined && docs !== "") parts.push(["## Durable docs", docs].join("\n"));
	if (review.trim() !== "") parts.push(["## Review", review.trim()].join("\n"));
	parts.push(`Refs #${state.issue.number}`);
	return { title: state.issue.title, body: parts.filter((p) => p !== "").join("\n\n") };
}
