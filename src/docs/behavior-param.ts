// Shape validation of `spec_gate`'s `behavior` parameter (durable-doc-checks "Behavior conclusion parameter"): a list
// of `{ capability, outcome, rationale }`. Pure; the rationale is agent text, so it comes back neutralised.

import { neutralise } from "../interaction/briefing.ts";
import type { BehaviorConclusionInput } from "./behavior-change.ts";

export type BehaviorParam = { ok: true; entries: BehaviorConclusionInput[] } | { ok: false; message: string };

export const RATIONALE_MAX = 300;
const KEYS = ["capability", "outcome", "rationale"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const refuse = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** The rationale of entry `i` neutralised, or the refusal text naming the rule it breaks. */
function rationaleOf(value: unknown, i: number): { text: string } | { refusal: string } {
	const field = `behavior[${i}].rationale`;
	if (typeof value !== "string") return { refusal: `${field} must be a string` };
	const trimmed = value.replace(/\r\n?/g, "\n").trim();
	if (trimmed === "") return { refusal: `${field} must not be empty` };
	if (trimmed.includes("\n")) return { refusal: `${field} must be one line` };
	if ([...trimmed].length > RATIONALE_MAX) return { refusal: `${field} must be at most ${RATIONALE_MAX} characters` };
	return { text: neutralise(trimmed) };
}

function entryOf(raw: unknown, i: number): { entry: BehaviorConclusionInput } | { refusal: string } {
	if (!isObject(raw)) return { refusal: `behavior[${i}] must be an object` };
	const odd = Object.keys(raw).find((k) => !KEYS.includes(k));
	if (odd !== undefined) return { refusal: `behavior[${i}].${odd} is not allowed; use ${KEYS.join(", ")}` };
	const { capability, outcome } = raw;
	if (typeof capability !== "string" || capability.trim() === "") return { refusal: `behavior[${i}].capability must be a non-empty string` };
	if (outcome !== "unchanged" && outcome !== "changed") return { refusal: `behavior[${i}].outcome must be unchanged or changed` };
	const rationale = rationaleOf(raw.rationale, i);
	if ("refusal" in rationale) return rationale;
	return { entry: { capability, outcome, rationale: rationale.text } };
}

/** `undefined` is an empty list; anything else must be a list of exact-key entries, each capability once. */
export function validateBehaviorParam(raw: unknown): BehaviorParam {
	if (raw === undefined) return { ok: true, entries: [] };
	if (!Array.isArray(raw)) return refuse("behavior must be a list of { capability, outcome, rationale }");
	const entries: BehaviorConclusionInput[] = [];
	for (const [i, item] of raw.entries()) {
		const checked = entryOf(item, i);
		if ("refusal" in checked) return refuse(checked.refusal);
		if (entries.some((e) => e.capability === checked.entry.capability)) return refuse(`behavior[${i}].capability ${checked.entry.capability} is listed twice`);
		entries.push(checked.entry);
	}
	return { ok: true, entries };
}
