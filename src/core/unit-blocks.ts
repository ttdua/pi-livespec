import { type Unit, parseChange } from "./change.ts";
import { type Eol, type Line, joinLines } from "./lines.ts";
import { replaceSection } from "./sections.ts";

export type UnitInput = {
	title: string;
	covers: string[];
	files: string[];
	done_means: { label: string; text: string }[];
	scenarios: { label: string; ref: string }[];
	depends: string[];
	verify: string;
	kind?: "refactor";
	extra_tags?: string[];
};

export type RenderableUnit = UnitInput & { id: string; difficulty: string; tags: string[] };

/** Renders a unit block in fixture field order; returns text lines without line endings. */
export function renderUnit(u: RenderableUnit): string[] {
	const lines = [
		`### ${u.id} — ${u.title}`,
		`Covers: ${u.covers.join(", ")}`,
		`Difficulty: ${u.difficulty}`,
		`Tags: [${u.tags.join(", ")}]`,
		`Files: ${u.files.join(", ")}`,
		"Done means:",
		...u.done_means.map((d) => `- [${d.label}] ${d.text}`),
		"Scenarios:",
		...u.scenarios.map((s) => `- [${s.label}] ${s.ref}`),
		`Depends: ${u.depends.length > 0 ? u.depends.join(", ") : "—"}`,
		`Verify: \`${u.verify}\``,
	];
	if (u.kind) lines.push(`Kind: ${u.kind}`);
	lines.push("- [ ] pending");
	return lines;
}

function eolOf(lines: Line[]): "\n" | "\r\n" {
	return lines[0]?.eol === "\r\n" ? "\r\n" : "\n";
}

function withEol(texts: string[], eol: Eol): Line[] {
	return texts.map((text) => ({ text, eol }));
}

function terminated(lines: Line[], eol: "\n" | "\r\n"): Line[] {
	const out = lines.slice();
	const last = out[out.length - 1];
	if (last && last.eol === "") out[out.length - 1] = { text: last.text, eol };
	return out;
}

function findUnit(units: Unit[], id: string): Unit {
	const u = units.find((x) => x.id === id);
	if (!u) throw new Error(`unit ${id} not found`);
	return u;
}

/** Replaces the unit's block (heading to status line); every other line stays byte-identical. */
export function replaceUnitBlock(body: string, id: string, lines: string[]): string {
	const change = parseChange(body);
	const u = findUnit(change.units, id);
	const eol = eolOf(change.lines);
	const keepEol = change.lines[u.endLine]!.eol || eol;
	const block = withEol(lines, eol);
	block[block.length - 1] = { text: lines[lines.length - 1]!, eol: keepEol };
	return joinLines([...change.lines.slice(0, u.startLine), ...block, ...change.lines.slice(u.endLine + 1)]);
}

/** Appends a block after the last unit, separated by a blank line; creates `## Units` when absent. */
export function insertUnitBlock(body: string, lines: string[]): string {
	const change = parseChange(body);
	const eol = eolOf(change.lines);
	const last = change.units[change.units.length - 1];
	if (!last) return replaceSection(body, "Units", lines.join("\n"));
	const head = terminated(change.lines.slice(0, last.endLine + 1), eol);
	const block = [{ text: "", eol } as Line, ...withEol(lines, eol)];
	const tail = change.lines.slice(last.endLine + 1);
	if (tail.length === 0) return joinLines([...head, ...block]);
	return joinLines([...head, ...block, ...tail]);
}

/** Removes the unit's block and the blank lines that follow it. */
export function removeUnitBlock(body: string, id: string): string {
	const change = parseChange(body);
	const u = findUnit(change.units, id);
	let end = u.endLine + 1;
	while (end < change.lines.length && change.lines[end]!.text.trim() === "") end++;
	return joinLines([...change.lines.slice(0, u.startLine), ...change.lines.slice(end)]);
}

/** Rewrites one `Difficulty:` or `Tags:` line inside the unit's block. */
export function setUnitField(body: string, id: string, field: "Difficulty" | "Tags", value: string): string {
	const change = parseChange(body);
	const u = findUnit(change.units, id);
	for (let i = u.startLine + 1; i <= u.endLine; i++) {
		const line = change.lines[i]!;
		if (!line.text.startsWith(`${field}:`)) continue;
		const out = change.lines.slice();
		out[i] = { text: `${field}: ${value}`, eol: line.eol };
		return joinLines(out);
	}
	throw new Error(`unit ${id} has no ${field} line`);
}
