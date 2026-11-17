// The review payload of a gate request (design D7). `collectReviewFacts` is the
// only I/O (the stat and names of `git diff <Base>..HEAD -- specs/`);
// `gatePayload` is pure.

import type { Unit } from "../core/change.ts";
import { sectionText } from "../core/sections.ts";
import { unitDigest } from "../core/digest.ts";
import { currentDecision, type DecisionRecord } from "../decide/records.ts";
import { registeredPayload } from "./gates.ts";
import type { Git } from "./git.ts";
import type { Pack } from "./pack-types.ts";
import { isGateOnly } from "./registry.ts";
import type { ChangeState } from "./state-types.ts";

export type ReviewFacts = { specsStat: string; specsFiles: string[]; issueUrl?: string };
export type GatePayload = { summary: string; links: string[]; files: string[] };

const SPECS_PATH = "specs/";
const PROPOSAL_LINES = 5;
const CLASSIFICATION_POINTS = ["tags", "difficulty"];

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
	const files = facts.specsFiles.length === 0 ? [] : ["Changed spec files:", ...facts.specsFiles.map((f) => `- ${f}`)];
	return [header, proposalSection(body, facts.issueUrl), diff, files];
}

function unitLine(u: Unit): string {
	const tags = `[${(u.tags ?? []).join(", ")}]`;
	return `- ${u.id} — ${u.title} · Difficulty: ${u.difficulty ?? "(missing)"} · Tags: ${tags} · Covers: ${u.covers.join(", ")}`;
}

/** The results of gate-only checks that ran for this gate request, so the human sees what they report. */
function gateCheckSection(state: ChangeState): string[] {
	const lines = state.checks.filter((c) => isGateOnly(c.check)).map((c) => `- ${c.check} (${c.severity}): ${c.message}`);
	return lines.length === 0 ? [] : ["Gate checks:", ...lines];
}

function planSections(state: ChangeState): string[][] {
	const units = ["Units:", ...state.change.units.map(unitLine)];
	const records = state.change.units.flatMap((u) => {
		const digest = unitDigest(u);
		return CLASSIFICATION_POINTS.map((point) => currentDecision(state.marked, point, u.id, digest)).filter(
			(r): r is DecisionRecord => r !== undefined,
		);
	});
	if (records.length === 0) return [units];
	const lines = records.map((r) => {
		const additions = r.agent_additions?.length ? ` (agent additions: ${r.agent_additions.join(", ")})` : "";
		return `- ${r.point}.${r.subject}: ${r.reason}${additions}`;
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
	const registered = isPhase ? registeredPayload(target, state, facts).map((t) => [t]) : [];
	const sections = [...(isPhase ? phaseSections(state, target, facts) : []), gateCheckSection(state), ...registered];
	const summary = [head, ...sections.filter((s) => s.length > 0)].map((s) => s.join("\n")).join("\n\n");
	return {
		summary,
		links: facts.issueUrl === undefined ? [] : [facts.issueUrl],
		files: target === "define" ? [...facts.specsFiles] : [],
	};
}
