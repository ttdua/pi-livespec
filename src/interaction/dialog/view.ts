// Renders the dialog state to terminal lines. Pure: a function of model, state, size and theme.
// Each tab yields a scrollable body (facts, briefing, review summary), fixed rows (entries,
// units, requirement rows) and a footer; `fitHeight` keeps the fixed rows and footer visible.
// Model text is already sanitised; theme colours wrap livespec's own chrome only, after wrapping.

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Override } from "../approver.ts";
import { type DialogEntry, type DialogModel, overridesOf, type TabName } from "./model.ts";
import type { DialogState, EditorName } from "./state.ts";

export type DialogTheme = { accent: (s: string) => string; muted: (s: string) => string; bold: (s: string) => string };

/** Below this width only the "too narrow" line is drawn. */
export const MIN_WIDTH = 40;
/** From this width descriptions and key hints are drawn. */
export const FULL_WIDTH = 60;

const NARROW_LINE = "Too narrow — widen or press Esc";
const TAB_TITLES: Record<TabName, string> = { decision: "Decision", units: "Adjust units", review: "Review" };
const EDITOR_TITLES: Record<EditorName, string> = { note: "Note:", answer: "Your answer:", requirement: "Changed requirement:", tags: "Tags" };
const FOCUS = "›";
const PICKED = " ✓";
const DESCRIPTION_INDENT = "    ";
const MAX_NUMBERED = 9;

type Ctx = { model: DialogModel; state: DialogState; width: number; full: boolean; theme: DialogTheme; editorLines: string[] };
type Layout = { body: string[]; fixed: string[]; footer: string[] };

const oneLine = (text: string): string => text.replaceAll("\n", " ");

/** `text` wrapped to `width`, the first line after `prefix` and the rest after `rest` (same width by default). */
function wrapWithPrefix(prefix: string, text: string, width: number, rest = " ".repeat(visibleWidth(prefix))): string[] {
	const room = Math.max(1, width - Math.max(visibleWidth(prefix), visibleWidth(rest)));
	const chunks = text === "" ? [""] : text.split("\n").flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, room)));
	return chunks.map((chunk, i) => (i === 0 ? prefix : rest) + chunk);
}

const wrap = (text: string, width: number): string[] => wrapWithPrefix("", text, width);

/** `1`–`9` for the first nine rows, a blank of the same width after. */
const numberOf = (index: number): string => (index < MAX_NUMBERED ? String(index + 1) : " ");

function rowPrefix(ctx: Ctx, index: number): string {
	const marker = index === ctx.state.focus ? ctx.theme.accent(FOCUS) : " ";
	return `${marker} ${numberOf(index)} `;
}

function tabStrip(ctx: Ctx): string {
	return ctx.model.tabs.map((tab, i) => (i === ctx.state.tab ? ctx.theme.bold(`[${TAB_TITLES[tab]}]`) : TAB_TITLES[tab])).join("  ");
}

// --- decision ---------------------------------------------------------------------------------

function factsSection(ctx: Ctx): string[] {
	const { model, width, theme } = ctx;
	const status = model.status.flatMap((s) => wrapWithPrefix(`${theme.accent(s.symbol)} `, oneLine(s.text), width));
	const briefing = model.briefing === undefined ? [] : ["", ...wrap(model.briefing.heading, width).map(theme.accent), ...model.briefing.lines.flatMap((l) => wrap(l, width))];
	return [...wrap(model.facts, width), ...status, ...briefing];
}

function entryLines(ctx: Ctx, entry: DialogEntry, index: number): string[] {
	const label = `${oneLine(entry.label)}${entry.recommended ? " (Recommended)" : ""}${index === ctx.state.picked ? PICKED : ""}`;
	const head = wrapWithPrefix(rowPrefix(ctx, index), label, ctx.width, "    ");
	if (!ctx.full || entry.description === undefined) return head;
	return [...head, ...wrapWithPrefix(DESCRIPTION_INDENT, entry.description, ctx.width).map(ctx.theme.muted)];
}

function decisionLayout(ctx: Ctx): Layout {
	return { body: factsSection(ctx), fixed: ["", ...ctx.model.entries.flatMap((e, i) => entryLines(ctx, e, i))], footer: noteLines(ctx) };
}

/** `Note: — (n: add)` or the note's first line; only for models with notes. */
function noteLines(ctx: Ctx): string[] {
	if (!ctx.model.notes) return [];
	const [first = "", ...more] = ctx.state.notes.trim().split("\n");
	const text = first === "" ? "— (n: add)" : `${first}${more.length > 0 ? " …" : ""} (n: edit)`;
	return wrapWithPrefix("Note: ", text, ctx.width);
}

// --- units ------------------------------------------------------------------------------------

function unitsLayout(ctx: Ctx): Layout {
	const { model, state } = ctx;
	const changed = new Set(overridesOf(model, state).map((o) => o.unit));
	const labelWidth = Math.max(0, ...model.units.map((u) => visibleWidth(oneLine(u.label))));
	const rows = model.units.flatMap((u, i) => {
		const set = state.overrides[u.unit];
		const difficulty = (set?.difficulty ?? u.difficulty ?? "—").padEnd("medium".length);
		const tags = `[${(set?.tags ?? u.tags).map(oneLine).join(", ")}]`;
		const label = oneLine(u.label) + " ".repeat(labelWidth - visibleWidth(oneLine(u.label)));
		const marker = i === state.focus ? ctx.theme.accent(FOCUS) : " ";
		return wrapWithPrefix(`${marker} `, `${label}  ${difficulty}  ${tags}${changed.has(u.unit) ? "  (changed)" : ""}`, ctx.width, "    ");
	});
	return { body: [], fixed: rows, footer: [] };
}

// --- review -----------------------------------------------------------------------------------

function outcomeOf(ctx: Ctx, entry: DialogEntry): string {
	if (entry.action.kind === "changes") return "changes requested";
	return ctx.model.notes && ctx.state.notes.trim() !== "" ? "approved with notes" : "approved";
}

function overrideText(o: Override, label: string): string {
	const parts = [...(o.difficulty === undefined ? [] : [`difficulty ${o.difficulty}`]), ...(o.tags === undefined ? [] : [`tags [${o.tags.join(", ")}]`])];
	return `${label}: ${parts.join(", ")}`;
}

function overrideLines(ctx: Ctx, entry: DialogEntry): string[] {
	const overrides = overridesOf(ctx.model, ctx.state);
	if (overrides.length === 0) return [];
	const labels = new Map(ctx.model.units.map((u) => [u.unit, oneLine(u.label)]));
	const heading = entry.action.kind === "changes" ? "Discarded with request changes:" : "Overrides:";
	return [heading, ...overrides.flatMap((o) => wrapWithPrefix("  ", overrideText(o, labels.get(o.unit) ?? o.unit), ctx.width))];
}

function answerOf(ctx: Ctx, entry: DialogEntry): string {
	if (entry.action.kind === "candidate") return oneLine(entry.label);
	return ctx.state.answer.trim() === "" ? "—" : ctx.state.answer.trim();
}

function reviewSummary(ctx: Ctx, entry: DialogEntry): string[] {
	const { width } = ctx;
	if (ctx.model.kind === "question") return wrapWithPrefix("Answer: ", answerOf(ctx, entry), width);
	const choice = entry.action.kind === "option" ? wrapWithPrefix("Choice: ", oneLine(entry.label), width) : [];
	return [`Outcome: ${outcomeOf(ctx, entry)}`, ...choice, ...noteLines(ctx), ...overrideLines(ctx, entry)];
}

/** `no`, each declared requirement, then `other`; `(•)` marks the pick. */
function requirementRows(ctx: Ctx): string[] {
	const { model, state } = ctx;
	const picked = state.requirement;
	const other = picked?.kind === "other" && picked.text.trim() !== "" ? `other: ${oneLine(picked.text.trim())}` : "other";
	const rows = [
		{ label: "no", on: picked?.kind === "none" },
		...model.requirements.map((r) => ({ label: oneLine(r.label), on: picked?.kind === "named" && picked.name === r.id })),
		{ label: other, on: picked?.kind === "other" },
	];
	return rows.flatMap((row, i) => wrapWithPrefix(`${rowPrefix(ctx, i)}(${row.on ? "•" : " "}) `, row.label, ctx.width, "      "));
}

function reviewLayout(ctx: Ctx): Layout {
	const { model, state } = ctx;
	const entry = state.picked === undefined ? undefined : model.entries[state.picked];
	if (entry === undefined) return { body: wrap("Nothing picked yet — pick an answer on the Decision tab.", ctx.width), fixed: [], footer: [] };
	const fixed = model.kind === "question" ? ["", "Does the answer change a requirement?", ...requirementRows(ctx)] : [];
	return { body: reviewSummary(ctx, entry), fixed, footer: [] };
}

// --- footer -----------------------------------------------------------------------------------

function editorTitle(ctx: Ctx, editor: EditorName): string {
	if (editor !== "tags") return EDITOR_TITLES[editor];
	const unit = ctx.model.units[ctx.state.focus];
	return `${EDITOR_TITLES.tags} of ${oneLine(unit?.label ?? "")} (comma-separated):`;
}

function hintOf(ctx: Ctx, tab: TabName): string {
	if (ctx.state.editor !== undefined) return "Enter save · Esc close editor";
	const note = ctx.model.notes ? " · n note" : "";
	if (tab === "decision") return `↑↓ move · 1-9 pick${note} · Tab next tab · Enter select · Esc cancel`;
	if (tab === "units") return "↑↓ move · ←→ difficulty · e tags · Tab next tab · Enter next · Esc cancel";
	if (ctx.model.kind === "question") return "↑↓ move · 1-9 pick · Enter pick, then submit · Tab tabs · Esc cancel";
	return `Enter submit${note} · Tab tabs · Esc cancel`;
}

/** The tab's footer, or the open editor in its place; then the error and, at full width, the key hints. */
function footerLines(ctx: Ctx, tab: TabName, tabFooter: string[]): string[] {
	const { editor, error } = ctx.state;
	const main = editor === undefined ? tabFooter : [...wrap(editorTitle(ctx, editor), ctx.width), ...ctx.editorLines];
	const errorLines = error === undefined ? [] : wrapWithPrefix(`${ctx.theme.accent("!")} `, error, ctx.width);
	const hints = ctx.full ? wrap(hintOf(ctx, tab), ctx.width).map(ctx.theme.muted) : [];
	const lines = [...main, ...errorLines, ...hints];
	return lines.length === 0 ? [] : ["", ...lines];
}

// --- composition ------------------------------------------------------------------------------

const LAYOUTS: Record<TabName, (ctx: Ctx) => Layout> = { decision: decisionLayout, units: unitsLayout, review: reviewLayout };

/** The body cut to the rows left over, scrolled by `scroll` (clamped), with a line above and below when cut. */
function fitHeight(ctx: Ctx, header: string[], layout: Layout, footer: string[], height: number): string[] {
	const { body } = layout;
	const room = height - header.length - layout.fixed.length - footer.length;
	if (body.length <= room) return [...header, ...body, ...layout.fixed, ...footer];
	const shown = Math.max(0, room - 2);
	const offset = Math.min(Math.max(0, ctx.state.scroll), body.length - shown);
	const below = body.length - offset - shown;
	const above = offset > 0 ? [ctx.theme.muted(`↑ ${offset} lines above (PgUp)`)] : [];
	const after = below > 0 ? [ctx.theme.muted(`↓ ${below} lines below (PgDn)`)] : [];
	return [...header, ...above, ...body.slice(offset, offset + shown), ...after, ...layout.fixed, ...footer];
}

/** Safety net only: wrapping keeps every line within `width`; a cut line would carry pi-tui's SGR reset. */
const clip = (line: string, width: number): string => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line);

/** The dialog as lines no wider than `size.width`; `editorLines` is the open editor, drawn in the footer. */
export function renderDialog(
	model: DialogModel,
	state: DialogState,
	size: { width: number; height: number },
	theme: DialogTheme,
	editorLines: string[] = [],
): string[] {
	const { width, height } = size;
	if (width < MIN_WIDTH) return [clip(NARROW_LINE, width)];
	const ctx: Ctx = { model, state, width, full: width >= FULL_WIDTH, theme, editorLines };
	const tab = model.tabs[state.tab] ?? "decision";
	const layout = LAYOUTS[tab](ctx);
	const lines = fitHeight(ctx, [tabStrip(ctx), ""], layout, footerLines(ctx, tab, layout.footer), height);
	return lines.map((line) => clip(line, width));
}
