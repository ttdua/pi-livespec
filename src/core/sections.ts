import { type Eol, type Line, joinLines, splitLines } from "./lines.ts";

/** Canonical H2 order of a change body. */
const CANONICAL_ORDER = ["Proposal", "Design", "Questions", "Units", "Durable docs"];
const H2 = /^## /;
const DEFAULT_EOL: Eol = "\n";

type Span = { start: number; end: number };

function bodyEol(lines: Line[]): Eol {
	return lines[0]?.eol || DEFAULT_EOL;
}

function eolOf(lines: Line[]): "\n" | "\r\n" {
	return bodyEol(lines) === "\r\n" ? "\r\n" : "\n";
}

/** Section span: `start` is the heading line, `end` is exclusive (next H2 or end of body). */
function findSection(lines: Line[], name: string): Span | undefined {
	const start = lines.findIndex((l) => l.text === `## ${name}`);
	if (start === -1) return undefined;
	let end = start + 1;
	while (end < lines.length && !H2.test(lines[end]!.text)) end++;
	return { start, end };
}

function contentLines(content: string, eol: "\n" | "\r\n", closeWithBlank: boolean): Line[] {
	const trimmed = content.replace(/(\r?\n)+$/, "");
	const out: Line[] = trimmed === "" ? [] : splitLines(trimmed).map((l) => ({ text: l.text, eol }));
	if (closeWithBlank) out.push({ text: "", eol });
	return out;
}

function ensureTerminated(lines: Line[], eol: "\n" | "\r\n"): void {
	const last = lines[lines.length - 1];
	if (last && last.eol === "") lines[lines.length - 1] = { text: last.text, eol };
}

export function sectionText(body: string, name: string): string | undefined {
	const lines = splitLines(body);
	const span = findSection(lines, name);
	if (!span) return undefined;
	const inner = lines.slice(span.start + 1, span.end).map((l) => l.text);
	while (inner.length > 0 && inner[inner.length - 1]!.trim() === "") inner.pop();
	while (inner.length > 0 && inner[0]!.trim() === "") inner.shift();
	return inner.join("\n");
}

/**
 * Replaces (or creates) the `## name` section. Lines outside the written region stay byte-identical
 * (text and eol). The only exception is a single unterminated final line of the body (or the heading
 * being written) when new lines must follow it: it keeps its text and gains the body's EOL.
 */
export function replaceSection(body: string, name: string, content: string): string {
	const lines = splitLines(body);
	const eol = eolOf(lines);
	const span = findSection(lines, name);
	if (span) {
		const last = span.end === lines.length;
		const fresh = contentLines(content, eol, !last);
		if (last) ensureTerminated(fresh, eol);
		const heading: Line = { text: lines[span.start]!.text, eol: lines[span.start]!.eol || eol };
		return joinLines([...lines.slice(0, span.start), heading, ...fresh, ...lines.slice(span.end)]);
	}
	return joinLines(insertSection(lines, name, content, eol));
}

function insertSection(lines: Line[], name: string, content: string, eol: "\n" | "\r\n"): Line[] {
	const later = CANONICAL_ORDER.slice(CANONICAL_ORDER.indexOf(name) + 1);
	const anchor = later.map((n) => findSection(lines, n)).find((s) => s !== undefined);
	const heading: Line = { text: `## ${name}`, eol };
	if (anchor) {
		const block = [heading, ...contentLines(content, eol, true)];
		return [...lines.slice(0, anchor.start), ...block, ...lines.slice(anchor.start)];
	}
	const head = lines.slice();
	ensureTerminated(head, eol);
	const needsGap = head.length > 0 && head[head.length - 1]!.text.trim() !== "";
	const block = [heading, ...contentLines(content, eol, false)];
	return [...head, ...(needsGap ? [{ text: "", eol }] : []), ...block];
}

/**
 * Sets `key: value` in the header (before the first H2). Other lines stay byte-identical; the only
 * exception is an unterminated final line of the body that a new line must follow, which keeps its
 * text and gains the body's EOL.
 */
export function setHeaderLine(body: string, key: string, value: string): string {
	const lines = splitLines(body);
	const eol = eolOf(lines);
	const firstH2 = lines.findIndex((l) => H2.test(l.text));
	const headerEnd = firstH2 === -1 ? lines.length : firstH2;
	const prefix = `${key}:`;
	const text = `${key}: ${value}`;
	const idx = lines.slice(0, headerEnd).findIndex((l) => l.text.startsWith(prefix));
	if (idx !== -1) {
		const old = lines[idx]!;
		return joinLines([...lines.slice(0, idx), { text, eol: old.eol }, ...lines.slice(idx + 1)]);
	}
	let at = headerEnd;
	while (at > 0 && lines[at - 1]!.text.trim() === "") at--;
	const head = lines.slice(0, at);
	ensureTerminated(head, eol);
	return joinLines([...head, { text, eol }, ...lines.slice(at)]);
}
