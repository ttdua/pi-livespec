// Candidate answers of `spec_question`: validated options A..D and the briefing that recommends one.
// A label is the answer text, so it must survive `/livespec answer Q<n> <label>` unchanged.

import type { Briefing, RequestOption } from "../interaction/approver.ts";
import { neutralise, validateBriefing, validateOptionTexts } from "../interaction/briefing.ts";

export type Candidate = { label: string; description: string };
export type CandidateParams = { candidates?: unknown; recommended?: unknown; rationale?: unknown };
export type CandidateRequest = { options: RequestOption[]; briefing: Briefing };

const MIN = 2;
const MAX = 4;
const IDS = ["A", "B", "C", "D"];

const refuse = (refused: string): { refused: string } => ({ refused });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why `label` could not come back through a forge command, or undefined. */
function labelProblem(label: string): string | undefined {
	if (label !== label.trim() || label === "") return "must not be empty or have leading or trailing space";
	if (/[\r\n]/.test(label)) return "must be one line";
	if (/\s/.test(label.replaceAll(" ", ""))) return "must use only plain spaces between words";
	if (/\s{2,}/.test(label)) return "must not contain two whitespace characters in a row";
	if (label.split(/\s+/).some((w) => w.startsWith("--"))) return "must not contain a word starting with --";
	if (neutralise(label) !== label) return "must not contain <!-- or start with /livespec";
	return undefined;
}

function optionsOf(raw: unknown[]): RequestOption[] | { refused: string } {
	const options: RequestOption[] = [];
	for (const [i, entry] of raw.entries()) {
		const where = `candidate ${i + 1}`;
		if (!isObject(entry) || typeof entry.label !== "string") return refuse(`${where} needs a label.`);
		const problem = labelProblem(entry.label);
		if (problem) return refuse(`${where} label ${problem}.`);
		if (options.some((o) => o.label === entry.label)) return refuse(`${where} repeats the label "${entry.label}".`);
		if (typeof entry.description !== "string") return refuse(`${where} needs a description.`);
		options.push({ id: IDS[i]!, label: entry.label, description: entry.description });
	}
	return options;
}

/** The shape rules that need no question text: candidates, `recommended` and `rationale` are required. */
export function candidateShape(p: CandidateParams): { refused: string } | undefined {
	if (p.candidates === undefined) return refuse(`give ${MIN} to ${MAX} candidates, each { label, description }, with recommended and rationale.`);
	if (!Array.isArray(p.candidates) || p.candidates.length < MIN || p.candidates.length > MAX) return refuse(`give ${MIN} to ${MAX} candidates.`);
	if (p.recommended === undefined) return refuse(`recommended is required: the id (${IDS.slice(0, p.candidates.length).join(", ")}) of the candidate you recommend.`);
	if (p.rationale === undefined) return refuse("rationale is required: why you recommend that candidate.");
	return undefined;
}

/** Options and briefing for `text`, or a refusal naming the bad candidate or field. */
export function candidateRequest(p: CandidateParams, text: string): CandidateRequest | { refused: string } {
	const shape = candidateShape(p);
	if (shape) return shape;
	const options = optionsOf(p.candidates as unknown[]);
	if ("refused" in options) return options;
	const described = validateOptionTexts(options, { requireDescription: true });
	if ("refused" in described) return refuse(`${described.refused.replace(/^option ([A-D])/, (_, id: string) => `candidate ${IDS.indexOf(id) + 1}`)}.`);
	const raw = { summary: text, recommended: p.recommended, rationale: p.rationale };
	const briefing = validateBriefing(raw, IDS.slice(0, described.length), { author: "agent" });
	if ("refused" in briefing) return refuse(`${briefing.refused.replace("briefing.summary", "the question text").replace("briefing.", "")}.`);
	return { options: described, briefing };
}
