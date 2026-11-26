// The plain text below the yaml of a forge `request` comment (design D7): heading,
// facts, failing checks, briefing, a How-to-answer table and the full command list.
// The parser ignores this text. Agent text is neutralised and escaped so it can add
// neither a section nor a command. Pure.

import type { ApprovalRequest, Briefing } from "./approver.ts";
import { neutralise } from "./briefing.ts";
import { gateChoices } from "./describe-actions.ts";
import { failingWaivableOf } from "./waive-rule.ts";

type Row = { choice: string; description: string; command: string; recommended: boolean };

const BRIEFING_HEADING: Record<Briefing["author"], string> = {
	agent: "Agent recommendation (agent-authored, advisory)",
	rule: "Livespec rule recommendation",
};

// --- escaping ------------------------------------------------------------------------

/** Agent text made inert for markdown: no fence, no heading at line start, no `<details>` tag. */
function inert(text: string): string {
	return neutralise(text)
		.replace(/(`{3,}|~{3,})/g, (fence) => fence.replace(/./g, "\\$&"))
		.replace(/<(\/?details)/gi, "&lt;$1")
		.split("\n")
		// A heading may follow indentation, list markers or quote markers.
		.map((line) => line.replace(/^([\s>*+\-\d.)]*)#/, "$1\\#"))
		.join("\n");
}

/** One table cell: one line, `|` escaped. */
function cell(text: string): string {
	return inert(text).replace(/\s*\n\s*/g, " ").replaceAll("|", "\\|");
}

/** A code span around `text` that survives backticks in it; `|` escaped for a table cell. */
function codeCell(text: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	const pad = longest > 0 ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`.replaceAll("|", "\\|");
}

const quote = (text: string): string[] => text.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));

// --- sections --------------------------------------------------------------------------

function decisionPhrase(subject: string): string {
	const colon = subject.indexOf(":");
	const prefix = subject.slice(0, colon);
	const rest = subject.slice(colon + 1);
	switch (prefix) {
		case "gate":
			return `approve the ${rest} gate`;
		case "amend":
			return `approve amendment ${rest}`;
		case "question":
			return `answer question ${rest}`;
		case "stuck":
			return `choose a way forward for stuck report ${rest}`;
		case "decide": {
			const dot = rest.indexOf(".");
			return dot === -1 ? `decide ${rest}` : `decide ${rest.slice(0, dot)} for ${rest.slice(dot + 1)}`;
		}
		default:
			return `answer ${subject}`;
	}
}

function heading(r: ApprovalRequest): string[] {
	return [`## Decision needed: ${decisionPhrase(r.subject)} on #${r.change}`];
}

function factsTitle(r: ApprovalRequest): string {
	if (r.subject.startsWith("amend:")) return "Amendment";
	if (r.subject.startsWith("decide:")) return "Rule decision";
	if (r.kind === "question") return "Question";
	if (r.kind === "stuck") return "Stuck report";
	return "Review";
}

function facts(r: ApprovalRequest): string[] {
	const out = [`### ${factsTitle(r)} (${r.mode})`, "", neutralise(r.summary)];
	if (r.files.length > 0) out.push("", "Files:", ...r.files.map((f) => `- ${f}`));
	if (r.links.length > 0) out.push("", "Links:", ...r.links.map((l) => `- ${l}`));
	return out;
}

function checks(r: ApprovalRequest): string[] {
	const failing = failingWaivableOf(r.record.snapshot);
	if (failing.length === 0) return [];
	return ["### Failing checks", "", "These waivable checks fail; approving needs `waive`.", "", "| Check |", "| --- |", ...failing.map((c) => `| ${codeCell(c)} |`)];
}

function briefingLines(b: Briefing): string[] {
	const lines = [b.summary];
	if (b.watch !== undefined && b.watch.length > 0) lines.push("", "Watch:", ...b.watch.map((w) => `- ${w}`));
	if (b.recommended !== undefined) lines.push("", `Recommended: ${b.recommended}`);
	if (b.rationale !== undefined) lines.push(`Rationale: ${b.rationale}`);
	return lines;
}

function briefing(r: ApprovalRequest): string[] {
	const b = r.briefing ?? r.record.briefing;
	if (b === undefined) return [];
	return [`### ${BRIEFING_HEADING[b.author] ?? BRIEFING_HEADING.agent}`, "", ...quote(inert(briefingLines(b).join("\n")))];
}

function questionId(r: ApprovalRequest): string {
	return r.question?.id ?? r.subject.slice("question:".length);
}

function answerRowsOf(r: ApprovalRequest): Row[] {
	const recommended = (r.briefing ?? r.record.briefing)?.recommended;
	if (r.kind !== "question") {
		return gateChoices(r).map((c) => ({ choice: c.label, description: c.description, command: c.command, recommended: c.id === recommended }));
	}
	const id = questionId(r);
	const candidates = (r.options ?? []).map((o) => ({ choice: o.label, description: o.description ?? "", command: `/livespec answer ${id} ${neutralise(o.label)}`, recommended: o.id === recommended }));
	return [...candidates, { choice: "your own answer", description: "Answer in your own words.", command: `/livespec answer ${id} <text>`, recommended: false }];
}

function answers(r: ApprovalRequest): string[] {
	const rows = answerRowsOf(r).map((row) => {
		const choice = row.recommended ? `**${cell(row.choice)}** (recommended)` : cell(row.choice);
		return `| ${choice} | ${cell(row.description)} | ${codeCell(row.command)} |`;
	});
	return ["### How to answer", "", "Post a new comment whose first line is the command (write access required).", "", "| Choice | What happens | Command |", "| --- | --- | --- |", ...rows];
}

function acceptedCommands(r: ApprovalRequest): string[] {
	if (r.kind === "question") {
		const id = questionId(r);
		return [`/livespec answer ${id} <text> [--changes <capability>/Requirement: <name>] [--class blocking|non-blocking]`, `/livespec class ${id} blocking|non-blocking`, "/livespec dismiss [notes]"];
	}
	if (r.kind === "stuck" || r.subject.startsWith("decide:")) return ["/livespec choose <option-id> [notes]", "/livespec dismiss [notes]"];
	const lines = ["/livespec approve [notes]", "/livespec changes <notes>", "/livespec dismiss [notes]"];
	if ((r.options ?? []).length > 0) lines.push("/livespec choose <option-id> [notes]");
	if (r.overridable) lines.push("/livespec set U<n> difficulty <low|medium|high>", "/livespec set U<n> tags <a,b,…>");
	return lines;
}

function details(r: ApprovalRequest): string[] {
	return ["<details>", "<summary>All accepted commands</summary>", "", ...acceptedCommands(r).map((c) => `- \`${c}\``), "", "</details>"];
}

/** The plain text of a forge `request` comment for `r`. */
export function renderForgeRequest(r: ApprovalRequest): string {
	const sections = [heading(r), facts(r), checks(r), briefing(r), answers(r), details(r)];
	return sections
		.filter((s) => s.length > 0)
		.map((s) => s.join("\n"))
		.join("\n\n");
}
