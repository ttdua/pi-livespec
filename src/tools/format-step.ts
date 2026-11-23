// Text of the read tools: the next step (shared by `spec_next` and
// `/livespec next`), the change state of `spec_status`, and the open-changes
// list. Forge text is wrapped as untrusted, like on the phase card.

import type { Question, Unit } from "../core/change.ts";
import { isKebabName } from "../core/names.ts";
import type { OpenChange } from "../engine/resolve-change.ts";
import type { ChangeState, NextStep } from "../engine/state-types.ts";
import { type FixCard, fixLaneText, fixNextStep, readinessText, untrusted } from "../hooks/phase-card.ts";
import { pendingText } from "../interaction/card.ts";
import { displayStuckId, displayUnitList } from "../interaction/display-ids.ts";

const NO_CHANGE_NEXT = "Run change_start #N to start or switch to one of the open changes, or create a change with change_new.";
const STALE_LINE = "Stale: built from cached forge data; it may be out of date.";

/** A phase id from a label is shown plain only when it looks like a pack id. */
function phaseId(id: string): string {
	return isKebabName(id) ? id : untrusted(id);
}

function listLines(title: string, items: string[]): string[] {
	return items.length === 0 ? [] : [`${title}:`, ...items.map((item) => `- ${item}`)];
}

function inlineLine(title: string, items: string[]): string[] {
	return items.length === 0 ? [] : [`${title}: ${items.join(", ")}`];
}

function phaseText(state: ChangeState, step: NextStep): string {
	if (step.phase !== undefined) return step.phase;
	const p = state.phase;
	if (p.kind === "ok") return phaseId(p.id);
	return p.kind === "missing" ? "none" : p.ids.map(phaseId).join(" + ");
}

function headerLine(state: ChangeState): string {
	return `Change #${state.issue.number} ${untrusted(state.issue.title)}`;
}

function counterText(c: NextStep["counters"][number]): string {
	return c.cap === undefined ? `${c.name} ${c.value}` : `${c.name} ${c.value}/${c.cap}`;
}

function stepLines(step: NextStep): string[] {
	return [
		`Next: ${untrusted(step.next)}`,
		...inlineLine("Required skills", step.required),
		...inlineLine("Optional skills", step.optional),
		...listLines("Redirects", step.redirects),
		...listLines("Blocking questions", step.blockingQuestions.map((q) => `${q.id}: ${untrusted(q.text)}`)),
		...inlineLine("Active units", step.activeUnits),
		...inlineLine("Waiting units", step.waitingUnits.map((b) => `${b.id} (waits on ${b.waitingOn.join(", ")})`)),
		...inlineLine("Started units", step.startedUnits),
		...inlineLine("Blocked units", step.blockedUnits.map((b) => `${b.id} (${b.reason})`)),
		...inlineLine("Unticked receipts", step.untickedReceipts),
		...inlineLine("Counters", step.counters.map(counterText)),
		...inlineLine("Incomplete", step.incomplete.map(untrusted)),
		...listLines("Pending approvals", step.pending.map(pendingText)),
		...inlineLine("Frozen units", displayUnitList(step.frozenUnits)),
		...inlineLine("Stale units", displayUnitList(step.staleUnits)),
		...(step.stuckOpen === undefined ? [] : [`Stuck report: ${displayStuckId(step.stuckOpen)}`]),
		...(step.advance === undefined ? [] : [`Advance: ${step.advance}`]),
	];
}

/** The next-step text: the same for `spec_next` and `/livespec next` on the same state. */
export function formatStep(step: NextStep, state: ChangeState): string {
	return [headerLine(state), `Phase: ${phaseText(state, step)}`, ...(state.stale ? [STALE_LINE] : []), ...stepLines(step)].join("\n");
}

function unitText(u: Unit): string {
	return `${u.id} — ${untrusted(u.title)}: ${u.done ? "done" : "pending"}`;
}

function questionText(q: Question): string {
	const answer = q.answer === undefined ? "" : ` — answer: ${untrusted(q.answer)}`;
	return `${q.id} (${q.kind}, ${q.checked ? "answered" : "open"}): ${untrusted(q.text)}${answer}`;
}

const overlapWarning = (o: NonNullable<ChangeState["deps"]>["overlap"][number]): string =>
	`#${o.number} ${untrusted(o.title)} also changes ${o.capabilities.map(untrusted).join(", ")}`;

function stateLines(state: ChangeState): string[] {
	const questions = state.change.questions.map(questionText);
	const checks = state.checks.map((c) => `${c.severity} ${c.check}: ${untrusted(c.message)}`);
	const counters = Object.keys(state.counters)
		.sort()
		.map((name) => `${name} ${state.counters[name]}`);
	return [
		...listLines("Units", state.change.units.map(unitText)),
		...listLines("Questions", questions),
		...inlineLine("Counters", counters),
		...listLines("Checks", checks),
		...listLines("Dependencies", (state.deps?.items ?? []).map((d) => `#${d.number} ${untrusted(d.title)}: ${d.state}`)),
		...listLines("Warnings", [...state.warnings.map(untrusted), ...(state.deps?.overlap ?? []).map(overlapWarning)]),
		`Stale: ${state.stale ? "yes" : "no"}`,
		`Read-only: ${state.readOnly ? "yes" : "no"}`,
	];
}

/** The `spec_status` text: the change state, then the next step. */
export function formatState(step: NextStep, state: ChangeState): string {
	return [headerLine(state), `Phase: ${phaseText(state, step)}`, ...stateLines(state), `Next: ${untrusted(step.next)}`].join("\n");
}

function openChangeText(c: OpenChange): string {
	return `#${c.number} ${untrusted(c.title)} (${c.phase === undefined ? "no phase" : phaseId(c.phase)})${readinessText(c.readiness)}`;
}

/** No change resolves on this branch: the open changes and how to start or switch to one. */
export function formatOpenChanges(open: OpenChange[]): string {
	const changes = open.length === 0 ? ["Open changes: none"] : listLines("Open changes", open.map(openChangeText));
	return ["No change is resolved on this branch.", ...changes, `Next: ${NO_CHANGE_NEXT}`].join("\n");
}

/** A fix branch: the slug, the lane outcome with its reasons, and the fix card's next step. */
export function formatFix(fix: FixCard): string {
	return [`Fix branch fix/${fix.slug}`, `Lane: ${fixLaneText(fix)}`, ...listLines("Reasons", (fix.outcome?.reasons ?? []).map(untrusted)), `Next: ${fixNextStep(fix)}`].join("\n");
}

/** The structured fix details of `spec_next` and `spec_status`. */
export function fixDetails(fix: FixCard): FixCard & { next: string } {
	return { ...fix, next: fixNextStep(fix) };
}
