// The review payload of a gate request (design D7). `collectReviewFacts` is the
// only I/O (the stat and names of `git diff <Base>..HEAD -- specs/`);
// `gatePayload` is pure.

import type { Unit } from "../core/change.ts";
import { sectionText } from "../core/sections.ts";
import { latestDecisions } from "../decide/records.ts";
import { registeredPayload } from "./gates.ts";
import type { Git } from "./git.ts";
import type { Pack } from "./pack-types.ts";
import type { ChangeState } from "./state-types.ts";

export type ReviewFacts = { specsStat: string; specsFiles: string[]; issueUrl?: string };
export type GatePayload = { summary: string; links: string[]; files: string[] };

const SPECS_PATH = "specs/";
const PROPOSAL_LINES = 5;
const CLASSIFICATION_POINTS = new Set(["tags", "difficulty"]);

/** The stat and file names of `git diff <base>..HEAD -- specs/`; empty without a `Base`. */
export async function collectReviewFacts(git: Pick<Git, "diffStat" | "diffNames">, base: string | undefined): Promise<ReviewFacts> {
	if (base === undefined) return { specsStat: "", specsFiles: [] };
	const [specsStat, specsFiles] = await Promise.all([git.diffStat(base, "HEAD", SPECS_PATH), git.diffNames(base, "HEAD", SPECS_PATH)]);
	return { specsStat, specsFiles };
}

/** Raw header line `<key>: <value>` exactly as the body has it, or undefined. */
function headerLine(state: ChangeState, key: string): string | undefined {
	return state.change.lines.find((l) => l.text.startsWith(`${key}:`))?.text;
}

function proposalSection(body: string, issueUrl: string | undefined): string[] {
	const text = (sectionText(body, "Proposal") ?? "").split("\n");
	const shown = text.length > PROPOSAL_LINES ? [...text.slice(0, PROPOSAL_LINES), "…"] : text;
	const out = ["Proposal:", ...shown];
	if (issueUrl !== undefined) out.push(`Full text: ${issueUrl}`);
	return out;
}

function defineSections(state: ChangeState, body: string, facts: ReviewFacts): string[][] {
	const header = ["Capabilities", "Product impact"].map((k) => headerLine(state, k)).filter((l): l is string => l !== undefined);
	const base = state.change.header.base ?? "<Base>";
	const diff = [`Spec diff (git diff --stat ${base}..HEAD -- specs/):`, facts.specsStat === "" ? "(no changes)" : facts.specsStat];
	return [header, proposalSection(body, facts.issueUrl), diff];
}

function unitLine(u: Unit): string {
	const tags = `[${(u.tags ?? []).join(", ")}]`;
	return `- ${u.id} — ${u.title} · Difficulty: ${u.difficulty ?? "(missing)"} · Tags: ${tags} · Covers: ${u.covers.join(", ")}`;
}

function planSections(state: ChangeState): string[][] {
	const units = ["Units:", ...state.change.units.map(unitLine)];
	const unitIds = new Set(state.change.units.map((u) => u.id));
	const records = [...latestDecisions(state.marked)].filter(([, r]) => CLASSIFICATION_POINTS.has(r.point) && unitIds.has(r.subject));
	if (records.length === 0) return [units];
	const lines = records.map(([id, r]) => {
		const additions = r.agent_additions?.length ? ` (agent additions: ${r.agent_additions.join(", ")})` : "";
		return `- ${id}: ${r.reason}${additions}`;
	});
	return [units, ["Decisions:", ...lines]];
}

function shipSections(body: string): string[][] {
	const table = sectionText(body, "Durable docs");
	return table === undefined ? [] : [["Durable docs:", table]];
}

/** The built-in sections of the phase's payload; named gates have none. */
function phaseSections(state: ChangeState, target: string, facts: ReviewFacts): string[][] {
	const body = state.change.lines.map((l) => l.text).join("\n");
	if (target === "define") return defineSections(state, body, facts);
	if (target === "plan") return planSections(state);
	if (target === "ship") return shipSections(body);
	return [];
}

/** The summary, links and files a human reviews for `target`; registered payload sections are appended last. */
export function gatePayload(state: ChangeState, pack: Pack, target: string, facts: ReviewFacts): GatePayload {
	const isPhase = pack.phases.some((p) => p.id === target);
	const head = [`Gate ${target} for #${state.issue.number} ${state.issue.title}.`];
	const sections = isPhase ? [...phaseSections(state, target, facts), ...registeredPayload(target, state, facts).map((t) => [t])] : [];
	const summary = [head, ...sections.filter((s) => s.length > 0)].map((s) => s.join("\n")).join("\n\n");
	return {
		summary,
		links: facts.issueUrl === undefined ? [] : [facts.issueUrl],
		files: target === "define" ? [...facts.specsFiles] : [],
	};
}
