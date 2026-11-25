// The phase card: a pure, deterministic rendering of what the agent should do
// next. Forge text is wrapped as untrusted; other specs append sections by
// registration (in registration order, after the built-in sections).

import { formatPackError } from "../commands/messages.ts";
import type { PackError } from "../engine/pack-types.ts";
import type { OpenChange } from "../engine/resolve-change.ts";
import type { ChangeState, NextStep } from "../engine/state-types.ts";
import type { LaneOutcome } from "../fix/lane.ts";

/** The forge-account state a card may show: the one-time choice notice and the write block. */
export type CardAccount = { line?: string; blocked?: string };

/** The fix branch part of the card: the lane outcome of the committed fix diff, nothing to ship, or why the facts failed. */
export type FixCard = { slug: string; outcome?: LaneOutcome; error?: string; empty?: true };

export type CardInput = {
	first: boolean;
	constraintsTemplate: boolean;
	unnotedSkills: string[];
	account?: CardAccount;
	/** Pending audit reasons, rendered by the `audit` section. */
	audit?: string[];
} & (
	| { kind: "change"; step: NextStep; state: ChangeState }
	| { kind: "list"; open: OpenChange[] }
	| { kind: "pack-errors"; errors: PackError[] }
	| { kind: "forge-unavailable"; message: string }
	| { kind: "change-error"; message: string }
	| ({ kind: "fix" } & FixCard)
);

export type CardSection = (i: CardInput) => string | undefined;

const HEADER = "livespec";
const SEPARATOR = " · ";
const STALE_LINE = "Stale: this card is built from cached forge data and may be out of date.";
const READ_ONLY_LINE = "Read-only: the forge is unreachable, so livespec writes are refused.";
const CONSTRAINTS_LINE = "specs/constraints.md is still the init template: draft it with the constraint-driven-development skill.";
const PRODUCT_LINE = "Read specs/product.md before you start: it describes the product this project builds.";
const LIST_NEXT = "Switch to a change branch livespec/<name>, or create a change with change_new.";
const PACK_ERRORS_NEXT = "Fix the flow pack errors below; livespec tools refuse until the pack is valid.";
const FORGE_UNAVAILABLE_NEXT = "Continue without the forge; livespec tools refuse writes until it is reachable.";
const CHANGE_ERROR_NEXT = "Fix the change issues so exactly one matches this branch.";
const PLAIN_PHASE = /^[a-z0-9-]+$/;
const FIX_COMMITTED_LINE = "The lane is computed from the committed fix diff; uncommitted edits are not counted.";

const sections = new Map<string, CardSection>();

/** Appends a section after the built-in ones; a name registered again keeps its position and gets the new renderer. */
export function registerCardSection(name: string, render: CardSection): void {
	sections.set(name, render);
}

export function resetCardSectionsForTests(): void {
	sections.clear();
}

/** Wraps forge text; `&` and `<` are escaped so the text cannot close the wrapper. */
export function untrusted(text: string): string {
	return `<untrusted>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</untrusted>`;
}

/** A phase id from a label is shown plain only when it looks like a pack id. */
function phaseText(phase: string): string {
	return PLAIN_PHASE.test(phase) ? phase : untrusted(phase);
}

function listLines(title: string, items: string[]): string[] {
	return items.length === 0 ? [] : [`${title}:`, ...items.map((item) => `- ${item}`)];
}

function inlineLine(title: string, items: string[]): string[] {
	return items.length === 0 ? [] : [`${title}: ${items.join(", ")}`];
}

function phaseOfState(state: ChangeState): string {
	const p = state.phase;
	if (p.kind === "ok") return phaseText(p.id);
	if (p.kind === "missing") return "no phase";
	return p.ids.map(phaseText).join(" + ");
}

function counterText(c: NextStep["counters"][number]): string {
	return c.cap === undefined ? `${c.name} ${c.value}` : `${c.name} ${c.value}/${c.cap}`;
}

function changeLines(step: NextStep, state: ChangeState): string[] {
	return [
		[HEADER, `#${state.issue.number} ${untrusted(state.issue.title)}`, step.phase ?? phaseOfState(state)].join(SEPARATOR),
		...(state.stale ? [STALE_LINE] : []),
		...(state.readOnly ? [READ_ONLY_LINE] : []),
		// `next` is engine copy that interpolates forge text (unit titles, check messages, label ids).
		`Next: ${untrusted(step.next)}`,
		...inlineLine("Required skills", step.required),
		...listLines("Redirects", step.redirects),
		...listLines("Blocking questions", step.blockingQuestions.map((q) => `${q.id}: ${untrusted(q.text)}`)),
		...inlineLine("Counters", step.counters.map(counterText)),
		...inlineLine("Active units", step.activeUnits),
		...inlineLine("Incomplete", step.incomplete.map(untrusted)),
	];
}

/** The one next-step sentence of a fix branch, shared by the card, `spec_next`, `spec_status` and `/livespec next`. */
export function fixNextStep(fix: FixCard): string {
	const branch = `fix/${fix.slug}`;
	// Reasons and errors carry repo text (requirement names, paths, git output), so they are data.
	if (fix.error !== undefined) return `The fix diff cannot be read: ${untrusted(fix.error)}. Fix the cause and refresh.`;
	if (fix.empty) return `Nothing to ship on ${branch}: it adds nothing to the integration branch. Switch back to the integration branch.`;
	if (fix.outcome?.lane === "forced") {
		return `This fix is not small (${fix.outcome.reasons.map(untrusted).join("; ")}): run change_new <name> --from-fix to move it into a full change.`;
	}
	return `Run fix_ship to push ${branch} and open its pull request.`;
}

/** The lane line of a fix: the outcome, or why there is none. */
export function fixLaneText(fix: FixCard): string {
	if (fix.error !== undefined) return "unknown";
	if (fix.empty) return "nothing to ship";
	return fix.outcome?.lane ?? "unknown";
}

/** The fix branch lines; no subagent step exists on this path (subagent-policy "Small-fix lane"). */
function fixLines(fix: FixCard): string[] {
	return [
		[HEADER, `fix/${fix.slug}`, `lane ${fixLaneText(fix)}`].join(SEPARATOR),
		`Next: ${fixNextStep(fix)}`,
		...listLines("Reasons", (fix.outcome?.reasons ?? []).map(untrusted)),
		FIX_COMMITTED_LINE,
	];
}

/** The readiness suffix of a listed change: ` ready`, ` waits for #34, #33`, ` parked`, or nothing when unknown. */
export function readinessText(r: OpenChange["readiness"]): string {
	if (r === undefined) return "";
	return typeof r === "string" ? ` ${r}` : ` waits for ${r.waits.map((n) => `#${n}`).join(", ")}`;
}

function openChangeText(c: OpenChange): string {
	return `#${c.number} ${untrusted(c.title)} (${c.phase === undefined ? "no phase" : phaseText(c.phase)})${readinessText(c.readiness)}`;
}

function listCardLines(open: OpenChange[]): string[] {
	const changes = open.length === 0 ? ["Open changes: none"] : listLines("Open changes", open.map(openChangeText));
	return [`${HEADER}${SEPARATOR}open changes`, `Next: ${LIST_NEXT}`, ...changes];
}

/** The lines specific to each card kind, before the shared trailing lines. */
function kindLines(i: CardInput): string[] {
	switch (i.kind) {
		case "change":
			return changeLines(i.step, i.state);
		case "list":
			return listCardLines(i.open);
		case "pack-errors":
			return [`${HEADER}${SEPARATOR}flow pack invalid`, `Next: ${PACK_ERRORS_NEXT}`, ...listLines("Pack errors", i.errors.map(formatPackError))];
		case "forge-unavailable":
			return [`${HEADER}${SEPARATOR}forge unavailable`, `Next: ${FORGE_UNAVAILABLE_NEXT}`, `The forge is unavailable: ${untrusted(i.message)}`];
		case "change-error":
			return [`${HEADER}${SEPARATOR}change not resolved`, `Next: ${CHANGE_ERROR_NEXT}`, untrusted(i.message)];
		case "fix":
			return fixLines(i);
	}
}

function warningLines(i: CardInput): string[] {
	return i.kind === "change" ? listLines("Warnings", i.state.warnings.map(untrusted)) : [];
}

function registeredLines(i: CardInput): string[] {
	return [...sections.values()].map((render) => render(i)).filter((text): text is string => text !== undefined && text !== "");
}

/** Pure: equal inputs (and equal registered sections) give the same text. */
export function renderCard(i: CardInput): string {
	const lines = [
		...kindLines(i),
		...(i.unnotedSkills.length === 0 ? [] : [`Needs skill note: ${i.unnotedSkills.join(", ")} (record why with skill_note)`]),
		...warningLines(i),
		...(i.constraintsTemplate ? [CONSTRAINTS_LINE] : []),
		...(i.first ? [PRODUCT_LINE] : []),
		...registeredLines(i),
	];
	return lines.join("\n");
}
