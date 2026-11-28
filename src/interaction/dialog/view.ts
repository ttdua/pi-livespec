// Renders the dialog state to terminal lines. Pure: a function of model, state, size and theme.
// Each tab yields a scrollable body (facts, briefing, review summary), fixed rows (entries,
// units, requirement rows) and a footer; `fitHeight` keeps the fixed rows and footer visible.
// Model text is already sanitised; theme colours wrap livespec's own chrome only, after wrapping.

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Override } from "../approver.ts";
import { type DialogEntry, type DialogModel, outcomeLabel, overridesOf, type TabName } from "./model.ts";
import { sanitize } from "./sanitize.ts";
import { type DialogState, type EditorName, tabsOf } from "./state.ts";

export type DialogTheme = { accent: (s: string) => string; muted: (s: string) => string; bold: (s: string) => string };

/** Below this width only the "too narrow" line is drawn. */
export const MIN_WIDTH = 40;
/** From this width descriptions and key hints are drawn. */
export const FULL_WIDTH = 60;

const NARROW_LINE = "Too narrow — widen or press Esc";
const TAB_TITLES: Record<TabName, string> = { decision: "Decision", units: "Adjust units", review: "Review" };
const EDITOR_TITLES: Record<EditorName, string> = { note: "Note:", answer: "Your answer:", tags: "Tags" };
const FOCUS = "›";
const PICKED = " ✓";
const DESCRIPTION_INDENT = "    ";
const MAX_NUMBERED = 9;

type Ctx = { model: DialogModel; state: DialogState; width: number; full: boolean; theme: DialogTheme; editorLines: string[] };
/** `keep` is the index in `fixed` of the focused row, the line kept in view when `fixed` has to shrink. */
type Layout = { body: string[]; fixed: string[]; keep: number; footer: string[] };
type Arranged = { ctx: Ctx; header: string[]; layout: Layout; footer: string[] };

const oneLine = (text: string): string => text.replaceAll("\n", " ");

/** Text typed in the dialog (`state.*`), made safe to draw like the model's agent text. */
const typed = (text: string): string => sanitize(text);

/** `lead` lines, then each row's lines; `keep` is where the `focus` row starts. */
function stack(lead: string[], rows: string[][], focus: number): Pick<Layout, "fixed" | "keep"> {
	return { fixed: [...lead, ...rows.flat()], keep: lead.length + rows.slice(0, focus).reduce((n, row) => n + row.length, 0) };
}

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
	return tabsOf(ctx.model, ctx.state).map((tab, i) => (i === ctx.state.tab ? ctx.theme.bold(`[${TAB_TITLES[tab]}]`) : TAB_TITLES[tab])).join("  ");
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
	const rows = ctx.model.entries.map((e, i) => entryLines(ctx, e, i));
	return { body: factsSection(ctx), ...stack([""], rows, ctx.state.focus), footer: noteLines(ctx) };
}

/** `Note: — (n: add)` or the note's first line; only for models with notes. */
function noteLines(ctx: Ctx): string[] {
	if (!ctx.model.notes) return [];
	const [first = "", ...more] = typed(ctx.state.notes).trim().split("\n");
	const text = first === "" ? "— (n: add)" : `${first}${more.length > 0 ? " …" : ""} (n: edit)`;
	return wrapWithPrefix("Note: ", text, ctx.width);
}

// --- units ------------------------------------------------------------------------------------

function unitsLayout(ctx: Ctx): Layout {
	const { model, state } = ctx;
	const changed = new Set(overridesOf(model, state).map((o) => o.unit));
	const labelWidth = Math.max(0, ...model.units.map((u) => visibleWidth(oneLine(u.label))));
	const rows = model.units.map((u, i) => {
		const set = state.overrides[u.unit];
		const difficulty = (set?.difficulty ?? u.difficulty ?? "—").padEnd("medium".length);
		const tags = `[${(set?.tags ?? u.tags).map((t) => oneLine(typed(t))).join(", ")}]`;
		const label = oneLine(u.label) + " ".repeat(labelWidth - visibleWidth(oneLine(u.label)));
		const marker = i === state.focus ? ctx.theme.accent(FOCUS) : " ";
		return wrapWithPrefix(`${marker} `, `${label}  ${difficulty}  ${tags}${changed.has(u.unit) ? "  (changed)" : ""}`, ctx.width, "    ");
	});
	return { body: [], ...stack([], rows, state.focus), footer: [] };
}

// --- review -----------------------------------------------------------------------------------

const outcomeText = (ctx: Ctx): string => outcomeLabel(ctx.model, ctx.state) ?? "—";

function overrideText(o: Override, label: string): string {
	const parts = [...(o.difficulty === undefined ? [] : [`difficulty ${o.difficulty}`]), ...(o.tags === undefined ? [] : [`tags [${o.tags.map((t) => oneLine(typed(t))).join(", ")}]`])];
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
	return ctx.state.answer.trim() === "" ? "—" : typed(ctx.state.answer.trim());
}

function reviewSummary(ctx: Ctx, entry: DialogEntry): string[] {
	const { width } = ctx;
	if (ctx.model.kind === "question") return wrapWithPrefix("Answer: ", answerOf(ctx, entry), width);
	const choice = entry.action.kind === "option" ? wrapWithPrefix("Choice: ", oneLine(entry.label), width) : [];
	return [`Outcome: ${outcomeText(ctx)}`, ...choice, ...noteLines(ctx), ...overrideLines(ctx, entry)];
}

function reviewLayout(ctx: Ctx): Layout {
	const { model, state } = ctx;
	const entry = state.picked === undefined ? undefined : model.entries[state.picked];
	if (entry === undefined) return { body: wrap("Nothing picked yet — pick an answer on the Decision tab.", ctx.width), fixed: [], keep: 0, footer: [] };
	return { body: reviewSummary(ctx, entry), fixed: [], keep: 0, footer: [] };
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
	const units = ctx.model.unitsAvailable && !ctx.state.unitsOpen ? " · u adjust units" : "";
	if (tab === "decision") return `↑↓ move · 1-9 pick${note}${units} · Tab next tab · Enter select · Esc cancel`;
	if (tab === "units") return "↑↓ move · ←→ difficulty · e tags · Tab next tab · Enter next · Esc cancel";
	if (ctx.model.kind === "question") return "Enter submit · Tab tabs · Esc cancel";
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

/** What the screen holds besides the body: the header, the fixed rows and the footer. */
type Frame = { header: string[]; fixed: string[]; footer: string[] };

const noBlank = (lines: string[]): string[] => lines.filter((line) => line !== "");

/** `fixed` cut to `budget` lines around the row at `keep`, with a `… N more` line when it has room. */
function shrinkFixed(ctx: Ctx, fixed: string[], keep: number, budget: number): string[] {
	if (fixed.length <= budget) return fixed;
	if (budget <= 1) return fixed.slice(keep, keep + 1);
	const start = Math.max(0, Math.min(keep, fixed.length - (budget - 1)));
	const shown = fixed.slice(start, start + budget - 1);
	return [...shown, ctx.theme.muted(`… ${fixed.length - shown.length} more`)];
}

/**
 * The footer (an open editor, its error, the key hints) stays whole and the fixed rows (entries, units,
 * requirements) shrink around the focused row when they do not fit; the blank spacer lines go first.
 */
function frameOf(a: Arranged, height: number): Frame {
	const { ctx, layout } = a;
	let { header, footer } = a;
	if (header.length + layout.fixed.length + footer.length <= height) return { header, fixed: layout.fixed, footer };
	if (header.length + footer.length + 1 > height) [header, footer] = [noBlank(header), noBlank(footer)];
	const fixed = shrinkFixed(ctx, layout.fixed, layout.keep, Math.max(1, height - header.length - footer.length));
	return { header, fixed, footer };
}

/** The first body line shown at the largest offset: the last page has only the "above" line. */
function maxOffset(bodyLength: number, room: number): number {
	return room <= 1 || bodyLength <= room ? 0 : Math.max(0, bodyLength - (room - 1));
}

/** The body cut to the rows left over, scrolled by `scroll` (clamped), with a line above and below when cut. */
function fitHeight(ctx: Ctx, body: string[], frame: Frame, height: number): string[] {
	const { header, fixed, footer } = frame;
	const room = height - header.length - fixed.length - footer.length;
	if (body.length <= room) return [...header, ...body, ...fixed, ...footer];
	// Entries and footer win over the body when even they do not fit; a single spare line says what is hidden.
	if (room <= 0) return [...header, ...fixed, ...footer];
	if (room === 1) return [...header, ctx.theme.muted(`↕ ${body.length} lines hidden (PgUp/PgDn)`), ...fixed, ...footer];
	const offset = Math.min(Math.max(0, ctx.state.scroll), maxOffset(body.length, room));
	const withAbove = Math.max(0, room - (offset > 0 ? 1 : 0));
	const shown = offset + withAbove >= body.length ? withAbove : Math.max(0, withAbove - 1);
	const below = body.length - offset - shown;
	const above = offset > 0 ? [ctx.theme.muted(`↑ ${offset} lines above (PgUp)`)] : [];
	const after = below > 0 ? [ctx.theme.muted(`↓ ${below} lines below (PgDn)`)] : [];
	return [...header, ...above, ...body.slice(offset, offset + shown), ...after, ...fixed, ...footer];
}

/** Safety net only: wrapping keeps every line within `width`; a cut line would carry pi-tui's SGR reset. */
const clip = (line: string, width: number): string => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line);

/** The layout the size allows: full, or on a short terminal without descriptions and hints so the entries stay visible. */
function arrange(model: DialogModel, state: DialogState, size: { width: number; height: number }, theme: DialogTheme, editorLines: string[]): Arranged {
	const tab = tabsOf(model, state)[state.tab] ?? "decision";
	const draw = (full: boolean): Arranged => {
		const ctx: Ctx = { model, state, width: size.width, full, theme, editorLines };
		const layout = LAYOUTS[tab](ctx);
		return { ctx, header: [tabStrip(ctx), ""], layout, footer: footerLines(ctx, tab, layout.footer) };
	};
	const wide = draw(size.width >= FULL_WIDTH);
	return wide.header.length + wide.layout.fixed.length + wide.footer.length < size.height ? wide : draw(false);
}

const PLAIN: DialogTheme = { accent: (s) => s, muted: (s) => s, bold: (s) => s };

/** The largest `state.scroll` that still moves the body: 0 when the body fits or the tab has none. Same layout as `renderDialog`. */
export function maxScrollOf(model: DialogModel, state: DialogState, size: { width: number; height: number }): number {
	if (size.width < MIN_WIDTH) return 0;
	const a = arrange(model, state, size, PLAIN, []);
	const { header, fixed, footer } = frameOf(a, size.height);
	return maxOffset(a.layout.body.length, size.height - header.length - fixed.length - footer.length);
}

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
	const a = arrange(model, state, size, theme, editorLines);
	// Still too tall (many entries, a tall editor): the bottom is cut so the height holds.
	return fitHeight(a.ctx, a.layout.body, frameOf(a, height), height)
		.slice(0, height)
		.map((line) => clip(line, width));
}
