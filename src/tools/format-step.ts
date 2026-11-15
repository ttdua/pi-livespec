// Text of the read tools: the next step (shared by `spec_next` and
// `/livespec next`), the change state of `spec_status`, and the open-changes
// list. Forge text is wrapped as untrusted, like on the phase card.

import type { Unit } from "../core/change.ts";
import { isKebabName } from "../core/names.ts";
import type { OpenChange } from "../engine/resolve-change.ts";
import type { ChangeState, NextStep } from "../engine/state-types.ts";
import { untrusted } from "../hooks/phase-card.ts";

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
		...inlineLine("Blocked units", step.blockedUnits.map((b) => `${b.id} (waits on ${b.waitingOn.join(", ")})`)),
		...inlineLine("Counters", step.counters.map(counterText)),
		...inlineLine("Incomplete", step.incomplete),
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

function stateLines(state: ChangeState): string[] {
	const questions = state.change.questions.map((q) => `${q.id} (${q.kind}, ${q.checked ? "answered" : "open"}): ${untrusted(q.text)}`);
	const checks = state.checks.map((c) => `${c.severity} ${c.check}: ${untrusted(c.message)}`);
	const counters = Object.keys(state.counters)
		.sort()
		.map((name) => `${name} ${state.counters[name]}`);
	return [
		...listLines("Units", state.change.units.map(unitText)),
		...listLines("Questions", questions),
		...inlineLine("Counters", counters),
		...listLines("Checks", checks),
		...listLines("Warnings", state.warnings.map(untrusted)),
		`Stale: ${state.stale ? "yes" : "no"}`,
		`Read-only: ${state.readOnly ? "yes" : "no"}`,
	];
}

/** The `spec_status` text: the change state, then the next step. */
export function formatState(step: NextStep, state: ChangeState): string {
	return [headerLine(state), `Phase: ${phaseText(state, step)}`, ...stateLines(state), `Next: ${untrusted(step.next)}`].join("\n");
}

function openChangeText(c: OpenChange): string {
	return `#${c.number} ${untrusted(c.title)} (${c.phase === undefined ? "no phase" : phaseId(c.phase)})`;
}

/** No change resolves on this branch: the open changes and how to start or switch to one. */
export function formatOpenChanges(open: OpenChange[]): string {
	const changes = open.length === 0 ? ["Open changes: none"] : listLines("Open changes", open.map(openChangeText));
	return ["No change is resolved on this branch.", ...changes, `Next: ${NO_CHANGE_NEXT}`].join("\n");
}
