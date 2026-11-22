// Next-step rule 7 (spec discovered-dependencies "New dependency follow-up"): after a valid approved
// `new-dependency` result, the step of its choice until a newer record shows it done. Pure.

import { type LatestDependencyChoice, latestDependencyChoice } from "../engine/deps-facts.ts";
import { validApproval } from "../engine/locks.ts";
import type { ChangeState, Decision } from "../engine/state-types.ts";
import type { MarkedComment } from "../forge/markers.ts";
import type { Outcome } from "../interaction/approver.ts";

const PLAN = "plan";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const after = (marked: MarkedComment[], index: number, keep: (m: MarkedComment) => boolean): boolean => marked.some((m, i) => i > index && keep(m));

const isParked = (m: MarkedComment): boolean => m.kind === "parked";
const isApprovedAmendment = (m: MarkedComment): boolean =>
	m.kind === "amendment" && isObject(m.data) && typeof m.data.outcome === "string" && validApproval({ outcome: m.data.outcome as Outcome, superseded: m.data.superseded === true });
const listsPlan = (m: MarkedComment): boolean => m.kind === "stale" && isObject(m.data) && Array.isArray(m.data.phases) && m.data.phases.includes(PLAN);

/** Whether the follow-up of `latest` is done, or has none (D `shape`: the phase move is all). */
function done(state: ChangeState, latest: LatestDependencyChoice): boolean {
	const { marked } = state;
	switch (latest.choice) {
		case "A":
			return after(marked, latest.index, isParked);
		case "B":
		case "C":
			return after(marked, latest.index, isApprovedAmendment);
		case "D":
			return latest.action !== "drop" || state.issue.state === "closed";
		case "split":
			return after(marked, latest.index, listsPlan);
	}
}

function followUpText(state: ChangeState, latest: LatestDependencyChoice): string {
	const pending = state.change.units.filter((u) => !u.done).map((u) => u.id);
	switch (latest.choice) {
		case "A":
			return "The new-dependency gate chose A: park the change with change_park until the prerequisite merges.";
		case "B":
			return "The new-dependency gate chose B: add the missing units with unit_amend --add.";
		case "C":
			return `The new-dependency gate chose C: stub the missing part with unit_amend ${latest.unit ?? "<unit>"}; the follow-up change exists.`;
		case "D":
			return `The new-dependency gate chose D: drop the change with change_close --abandon "${latest.reason ?? ""}".`;
		case "split":
			return `The new-dependency gate chose split: move the units not done (${pending.join(", ")}) to a new change with change_split.`;
	}
}

/** The follow-up step of the latest valid approved `new-dependency` result, or undefined when none is left. */
export function dependencyFollowUp(state: ChangeState): Decision | undefined {
	const latest = latestDependencyChoice(state.marked);
	if (latest === undefined || done(state, latest)) return undefined;
	return { next: followUpText(state, latest) };
}
