// Pure rules of `spec_write`: content validation, the body edit and the
// postconditions that the edit kept every other line byte-identical.

import { parseChange } from "../core/change.ts";
import { type Line, splitLines } from "../core/lines.ts";
import { isKebabName } from "../core/names.ts";
import { replaceSection, sectionText, setHeaderLine } from "../core/sections.ts";

export const SPEC_WRITE_SECTIONS = ["Capabilities", "Product impact", "Proposal", "Design"] as const;
export type SpecWriteSection = (typeof SPEC_WRITE_SECTIONS)[number];

type HeaderSection = Extract<SpecWriteSection, "Capabilities" | "Product impact">;
type BodySection = Extract<SpecWriteSection, "Proposal" | "Design">;

export type Capabilities = { new: string[]; modified: string[] };

/** A validated write: what goes into the body and what the postconditions compare. */
export type PlannedWrite =
	| { kind: "header"; section: HeaderSection; value: string; capabilities?: Capabilities }
	| { kind: "body"; section: BodySection; content: string };

const CAPABILITIES = /^new \[(.*)\], modified \[(.*)\]$/;
const H2_LINE = /^## /;
const UNITS_OWNER = "Units is written by the plan_units tool (LS-05), not by spec_write.";

function isSection(s: string): s is SpecWriteSection {
	return (SPEC_WRITE_SECTIONS as readonly string[]).includes(s);
}

function names(list: string): string[] {
	return list.trim() === "" ? [] : list.split(",").map((n) => n.trim());
}

function validateCapabilities(value: string): { ok: true; capabilities: Capabilities } | { ok: false; message: string } {
	const m = CAPABILITIES.exec(value);
	if (!m) return { ok: false, message: `Capabilities must read "new [a, b], modified [c]"; got "${value}".` };
	const capabilities = { new: names(m[1] as string), modified: names(m[2] as string) };
	const bad = [...capabilities.new, ...capabilities.modified].filter((n) => !isKebabName(n));
	if (bad.length > 0) return { ok: false, message: `Capability names must be kebab-case (a-z, 0-9, single hyphens): ${bad.map((b) => `"${b}"`).join(", ")}.` };
	return { ok: true, capabilities };
}

/** Lines without leading and trailing blank lines, joined with `\n`: the form `sectionText` returns. */
export function normalizeContent(content: string): string {
	const lines = splitLines(content).map((l) => l.text);
	while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
	return lines.join("\n");
}

function planBody(section: BodySection, content: string): { ok: true; write: PlannedWrite } | { ok: false; message: string } {
	const normalized = normalizeContent(content);
	if (normalized === "") return { ok: false, message: `${section} must not be empty.` };
	if (normalized.split("\n").some((l) => H2_LINE.test(l))) {
		return { ok: false, message: `${section} must not contain a level-2 heading ("## "); use ### or lower inside a section.` };
	}
	return { ok: true, write: { kind: "body", section, content: normalized } };
}

function planHeader(section: HeaderSection, content: string): { ok: true; write: PlannedWrite } | { ok: false; message: string } {
	const value = content.trim();
	if (value === "" || /[\r\n]/.test(value)) return { ok: false, message: `${section} must be one non-empty line.` };
	if (section === "Product impact") return { ok: true, write: { kind: "header", section, value } };
	const caps = validateCapabilities(value);
	return caps.ok ? { ok: true, write: { kind: "header", section, value, capabilities: caps.capabilities } } : caps;
}

/** Validates the section name and content; nothing is read or written. */
export function planWrite(section: string, content: string): { ok: true; write: PlannedWrite } | { ok: false; message: string } {
	if (section === "Units") return { ok: false, message: UNITS_OWNER };
	if (!isSection(section)) return { ok: false, message: `spec_write writes only ${SPEC_WRITE_SECTIONS.join(", ")}; got "${section}".` };
	if (section === "Proposal" || section === "Design") return planBody(section, content);
	return planHeader(section, content);
}

export function applyWrite(body: string, w: PlannedWrite): string {
	return w.kind === "header" ? setHeaderLine(body, w.section, w.value) : replaceSection(body, w.section, w.content);
}

// --- postconditions ----------------------------------------------------------

/** Equal text and EOL, except that an unterminated final expected line may have gained an EOL. */
function sameLines(expected: Line[], actual: Line[]): boolean {
	if (expected.length !== actual.length) return false;
	return expected.every((e, i) => {
		const a = actual[i] as Line;
		const lastUnterminated = i === expected.length - 1 && e.eol === "";
		return e.text === a.text && (e.eol === a.eol || lastUnterminated);
	});
}

function sectionSpan(lines: Line[], name: string): { start: number; end: number } | undefined {
	const start = lines.findIndex((l) => l.text === `## ${name}`);
	if (start === -1) return undefined;
	let end = start + 1;
	while (end < lines.length && !H2_LINE.test(lines[end]!.text)) end++;
	return { start, end };
}

function withoutSpan(lines: Line[], span: { start: number; end: number }): Line[] {
	return [...lines.slice(0, span.start), ...lines.slice(span.end)];
}

/** A section appended at the end of the body may be preceded by one new blank separator line. */
function dropAppendGap(outside: Line[], span: { start: number; end: number }, total: number, expectedLength: number): Line[] {
	const appended = span.end === total && span.start > 0 && outside.length === expectedLength + 1;
	return appended && outside[span.start - 1]!.text.trim() === "" ? [...outside.slice(0, span.start - 1), ...outside.slice(span.start)] : outside;
}

function bodyOutsideUnchanged(before: string, after: string, section: string): boolean {
	const old = splitLines(before);
	const fresh = splitLines(after);
	const span = sectionSpan(fresh, section);
	if (!span) return false;
	const oldSpan = sectionSpan(old, section);
	const expected = oldSpan ? withoutSpan(old, oldSpan) : old;
	const outside = dropAppendGap(withoutSpan(fresh, span), span, fresh.length, expected.length);
	return sameLines(expected, outside);
}

function headerIndex(lines: Line[], key: string): number {
	const firstH2 = lines.findIndex((l) => H2_LINE.test(l.text));
	const end = firstH2 === -1 ? lines.length : firstH2;
	return lines.slice(0, end).findIndex((l) => l.text.startsWith(`${key}:`));
}

function headerOutsideUnchanged(before: string, after: string, key: string): boolean {
	const old = splitLines(before);
	const fresh = splitLines(after);
	const at = headerIndex(fresh, key);
	if (at === -1) return false;
	const oldAt = headerIndex(old, key);
	const expected = oldAt === -1 ? old : [...old.slice(0, oldAt), ...old.slice(oldAt + 1)];
	return sameLines(expected, [...fresh.slice(0, at), ...fresh.slice(at + 1)]);
}

function sameCapabilities(a: Capabilities | undefined, b: Capabilities): boolean {
	return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** Why the edited body breaks a postcondition, or undefined when it holds. */
export function postconditionFailure(before: string, after: string, w: PlannedWrite): string | undefined {
	if (w.kind === "body") {
		if (sectionText(after, w.section) !== w.content) return `## ${w.section} does not hold the written content`;
		if (!bodyOutsideUnchanged(before, after, w.section)) return `a line outside ## ${w.section} would change`;
		return undefined;
	}
	const header = parseChange(after).header;
	if (!headerOutsideUnchanged(before, after, w.section)) return `a line other than ${w.section}: would change`;
	if (w.capabilities) return sameCapabilities(header.capabilities, w.capabilities) ? undefined : "the Capabilities line does not parse back to the written lists";
	return header.productImpact === w.value ? undefined : "the Product impact line does not parse back to the written value";
}
