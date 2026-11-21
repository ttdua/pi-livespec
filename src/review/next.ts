// Next steps of the `review` phase (review-phase "Review next steps", design D8, D12): pure, from the pack and state.

import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState, Decision } from "../engine/state-types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import type { ReviewSubject } from "../subagents/roles.ts";
import { aggregates, runAtHead } from "./records.ts";
import { completedReview, type NextStage, nextStage, stillBlocked } from "./round.ts";
import { normalizeLocation } from "./route.ts";
import { blockingFindings, reviewRounds } from "./status.ts";

const BUILD_PHASE = "build";
const REVIEW_PHASE = "review";
const SIMPLIFY_SKILL = "review.code-simplification";
const SIMPLIFY_TITLE = "simplify";

const STAGE_TEXT: Partial<Record<NextStage["stage"], string>> = {
	start: "start a round",
	review: "launch the missing reviewers",
	aggregate: "aggregate the reviews",
	verify: "verify the findings",
	route: "route the findings",
};

/** The inline runs of the reviewers or verifiers a stage still needs, when no executor can launch them. */
function inlineHint(state: ChangeState, stage: NextStage): string {
	if (state.subagents.executor.ok || stage.missing === undefined || stage.missing.length === 0) return "";
	const role = stage.stage === "verify" ? "verifier" : "reviewer";
	const runs = (stage.missing as string[]).map((t) => `subagent_packet ${role} ${t}, then subagent_record ${role} ${t}`);
	return ` No capable subagent executor: run each inline (${runs.join("; ")}), then call spec_review again.`;
}

/** The `spec_review` sentence, naming the stage it runs, the inline runs and why it refuses, when it does. */
function specReview(state: ChangeState, stage: NextStage): Decision {
	const what = STAGE_TEXT[stage.stage];
	const named = what === undefined ? "" : ` It will ${what}.`;
	const refusal = stage.stage === "refused" ? ` It refuses now: ${stage.reason}` : "";
	return { next: `Run spec_review.${named}${inlineHint(state, stage)}${refusal}` };
}

/** Rule 1: a selected reviewer of the round at HEAD ended `BLOCKED` and no stuck answer lifted it. */
function blockedReviewer(state: ChangeState, selected: ReviewSubject[]): ReviewSubject | undefined {
	const head = state.git.head;
	return selected.find((s) => completedReview(state.marked, s, head) === undefined && stillBlocked(state.marked, s, head));
}

/** The latest aggregate when it reviewed HEAD. */
function aggregateAtHead(state: ChangeState): ReturnType<typeof aggregates>[number] | undefined {
	const latest = aggregates(state.marked).at(-1);
	return latest?.data.head === state.git.head ? latest : undefined;
}

/** The location of the first blocking `in-change` finding of the aggregate at HEAD. */
function inChangeLocation(state: ChangeState): string | undefined {
	const latest = aggregateAtHead(state);
	if (latest === undefined) return undefined;
	const first = blockingFindings(state.marked, latest.commentId, state.change.questions).find((b) => b.finding.route === "in-change");
	return first?.finding.location;
}

/** Design D12: offered before the gate when the skill was read, no `simplify` unit exists and the round at HEAD is clean. */
function simplifyOffer(state: ChangeState): Decision | undefined {
	if (!state.skillNotes.includes(SIMPLIFY_SKILL) || state.lock.gates[REVIEW_PHASE] !== undefined) return undefined;
	if (state.change.units.some((u) => u.title.trim().toLowerCase() === SIMPLIFY_TITLE)) return undefined;
	const latest = aggregateAtHead(state);
	if (latest === undefined || blockingFindings(state.marked, latest.commentId, state.change.questions).length > 0) return undefined;
	return { next: `Add a ${SIMPLIFY_TITLE} unit with unit_amend --add (Kind: refactor, Verify: the full test suite) so the next round reviews the simplified code, or request the ${REVIEW_PHASE} gate.` };
}

/** Rule 14 (design D8): the review step before the gate, or undefined when the gate is next. */
export function reviewStep(pack: Pack, state: ChangeState): Decision | undefined {
	const run = runAtHead(state.marked, state.git.head);
	const blocked = run === undefined ? undefined : blockedReviewer(state, run.selected);
	if (blocked !== undefined) return { next: `The ${blocked} reviewer ended BLOCKED at HEAD: send a stuck report with spec_stuck naming ${blocked}.` };
	const stage = nextStage(state, pack);
	if (run !== undefined && !run.routed && stage.stage !== "refused") return specReview(state, stage);
	const rounds = reviewRounds(state.marked, pack.loops.review_rounds);
	if (rounds.blocking) return { next: `review_rounds reached ${rounds.value} of ${pack.loops.review_rounds}: send a stuck report with spec_stuck.` };
	const pending = state.change.units.filter((u) => !u.done).map((u) => u.id);
	if (pending.length > 0) return { next: `Return to build to rebuild ${pending.join(", ")}.`, advance: BUILD_PHASE };
	if (run === undefined || !run.routed) return specReview(state, stage);
	const location = inChangeLocation(state);
	if (location?.startsWith("check:")) return { next: `Fix the failing check ${untrusted(location.slice("check:".length))} in a unit added with unit_amend --add.` };
	if (location !== undefined) return { next: `A blocking in-change finding is at ${untrusted(normalizeLocation(location).path)}: add a unit for it with unit_amend --add.` };
	return simplifyOffer(state);
}
