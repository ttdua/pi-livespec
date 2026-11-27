// Pure validation of agent-supplied request text (briefing, option texts) and its neutralisation.

import type { Briefing, RequestOption } from "./approver.ts";

type Refused = { refused: string };
type Author = Briefing["author"];

const SUMMARY_MAX = 600;
const RATIONALE_MAX = 600;
const WATCH_MAX_ITEMS = 5;
const WATCH_ITEM_MAX = 200;
const DESCRIPTION_MAX = 200;
const ZWSP = "\u200b";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const refuse = (refused: string): Refused => ({ refused });
const isRefused = (v: unknown): v is Refused => isObject(v) && typeof v.refused === "string";
const length = (s: string): number => [...s].length;
const normalise = (s: string): string => s.replace(/\r\n?/g, "\n").trimEnd();

/** Breaks `<!--` and a leading `/livespec` so agent text can neither open a comment nor pass as a command. */
export function neutralise(text: string): string {
	return text
		.replaceAll("<!--", `<!-${ZWSP}-`)
		.split("\n")
		.map((line) => (line.startsWith("/livespec") ? ZWSP + line : line))
		.join("\n");
}

/** A string field: normalised, non-empty, within `max` code points, and one line unless `multiline` (then no blank line). */
function text(field: string, value: unknown, max: number, multiline: boolean): string | Refused {
	if (typeof value !== "string") return refuse(`${field} must be a string`);
	const s = normalise(value).trimStart();
	if (s === "") return refuse(`${field} must not be empty`);
	if (length(s) > max) return refuse(`${field} must be at most ${max} characters`);
	if (!multiline && s.includes("\n")) return refuse(`${field} must be one line`);
	if (multiline && /\n[ \t]*\n/.test(s)) return refuse(`${field} must not contain a blank line`);
	return neutralise(s);
}

function watchItems(value: unknown): string[] | Refused {
	if (!Array.isArray(value)) return refuse("briefing.watch must be a list");
	if (value.length > WATCH_MAX_ITEMS) return refuse(`briefing.watch must have at most ${WATCH_MAX_ITEMS} items`);
	const out: string[] = [];
	for (const [i, item] of value.entries()) {
		const t = text(`briefing.watch[${i}]`, item, WATCH_ITEM_MAX, false);
		if (isRefused(t)) return t;
		out.push(t);
	}
	return out;
}

function recommendation(raw: Record<string, unknown>, choices: string[]): Pick<Briefing, "recommended" | "rationale"> | Refused {
	const { recommended, rationale } = raw;
	if (recommended === undefined) {
		return rationale === undefined ? {} : refuse("briefing.rationale is not allowed without briefing.recommended");
	}
	if (typeof recommended !== "string" || !choices.includes(recommended)) {
		return refuse(`briefing.recommended must be one of the offered choices: ${choices.join(", ")}`);
	}
	if (rationale === undefined) return refuse("briefing.rationale is required when briefing.recommended is set");
	const r = text("briefing.rationale", rationale, RATIONALE_MAX, true);
	return isRefused(r) ? r : { recommended, rationale: r };
}

/** Validates `raw` against the briefing shape; `choices` are the offered ids a recommendation may name. */
export function validateBriefing(raw: unknown, choices: string[], o: { author: Author }): Briefing | Refused {
	if (!isObject(raw)) return refuse("briefing must be an object");
	const summary = text("briefing.summary", raw.summary, SUMMARY_MAX, true);
	if (isRefused(summary)) return summary;
	const out: Briefing = { summary, author: o.author };
	if (raw.watch !== undefined) {
		const watch = watchItems(raw.watch);
		if (isRefused(watch)) return watch;
		if (watch.length > 0) out.watch = watch;
	}
	const rec = recommendation(raw, choices);
	if (isRefused(rec)) return rec;
	return { ...out, ...rec };
}

/** Validates option labels and descriptions; returns neutralised copies. */
export function validateOptionTexts(options: RequestOption[], o: { requireDescription: boolean }): RequestOption[] | Refused {
	const out: RequestOption[] = [];
	for (const option of options) {
		const label = text(`option ${option.id} label`, option.label, Number.POSITIVE_INFINITY, false);
		if (isRefused(label)) return label;
		if (option.description === undefined) {
			if (o.requireDescription) return refuse(`option ${option.id} description is required`);
			out.push({ ...option, label });
			continue;
		}
		const description = text(`option ${option.id} description`, option.description, DESCRIPTION_MAX, false);
		if (isRefused(description)) return description;
		out.push({ ...option, label, description });
	}
	return out;
}

/** A briefing a tool must receive: present, and naming `recommended` (checked first) and `rationale`. */
export function validateRequiredBriefing(raw: unknown, choices: string[], o: { author: Author }): Briefing | Refused {
	if (raw === undefined) return refuse("briefing is required: pass `briefing` with a summary, `recommended` and `rationale`");
	if (isObject(raw) && raw.recommended === undefined) return refuse("briefing.recommended is required");
	if (isObject(raw) && raw.rationale === undefined) return refuse("briefing.rationale is required");
	return validateBriefing(raw, choices, o);
}
