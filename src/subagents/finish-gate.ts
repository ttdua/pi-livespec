// What `unit_finish` checks before anything else: unresolved blocking findings and a required unit review.

import type { Git } from "../engine/git.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { policyFacts } from "./build-loop.ts";
import { entriesFor, holds } from "./policy.ts";
import { answeredFindingKeys, completedReviewAt, findingKey, gatesShownKeys, unresolvedBlocking, type UnresolvedFinding } from "./records.ts";

const short = (sha: string): string => sha.slice(0, 7);

/** The fix-or-rebut options of one open finding, naming the route its scope and kind allow. */
function describe({ comment, index, finding }: UnresolvedFinding): string {
	const head = `${finding.severity} ${finding.kind} at ${finding.location} (${comment}:${index}): ${finding.evidence}`;
	if (finding.scope === "needs-decision") return `${head}\n  raise it with spec_question, starting the text with finding:${findingKey(comment, index)}, and wait for the answer.`;
	if (finding.scope === "out-of-scope") return `${head}\n  it is attached to the next human gate; it counts as resolved once a gate shows it.`;
	const rebut = finding.kind === "missed-context" ? "" : ` or rebut it with finding_rebut ${comment} ${index} <reason> <evidence>`;
	return `${head}\n  fix it (${finding.fix}) and run the unit review again${rebut}.`;
}

function findingsRefusal(state: ChangeState, unit: string): string | undefined {
	const open = unresolvedBlocking(state.marked, unit, answeredFindingKeys(state.change.questions), gatesShownKeys(state.marked));
	return open.length === 0 ? undefined : `${unit} has ${open.length} unresolved blocking finding(s):\n${open.map(describe).join("\n")}`;
}

/** The commits whose review counts: HEAD, plus the lane head a merge commit at HEAD brought in as its second parent. */
async function reviewedCommits(head: string, git: Git): Promise<string[]> {
	const parents = await git.parents(head);
	return parents.length > 1 ? [head, parents[1] as string] : [head];
}

/** Whether the pack's non-advisory unit reviewer holds for `unit`, with `context>=N%` conditions left out. */
function reviewRequired(state: ChangeState, pack: Pack, unit: string): boolean {
	const phase = pack.phases.find((p) => p.id === (state.phase.kind === "ok" ? state.phase.id : undefined));
	const target = state.change.units.find((u) => u.id === unit);
	if (phase === undefined || target === undefined) return false;
	const entry = entriesFor(pack, phase.id).find((e) => e.role === "reviewer" && e.subject === "unit");
	if (entry === undefined || entry.mode === "off" || entry.advisory === true) return false;
	return entry.mode === "always" || holds(entry, { ...policyFacts(state, phase, target), turnsCompleted: 0 });
}

async function reviewRefusal(state: ChangeState, pack: Pack, unit: string, git: Git): Promise<string | undefined> {
	if (!reviewRequired(state, pack, unit)) return undefined;
	if (completedReviewAt(state.marked, unit, await reviewedCommits(state.git.head, git))) return undefined;
	const how = state.subagents.executor.ok ? `subagent_dispatch reviewer ${unit} unit` : `subagent_packet reviewer ${unit} unit, then record it with subagent_record reviewer ${unit} unit`;
	return `${unit} needs a completed unit review of ${short(state.git.head)}: run ${how}.`;
}

/** Why `unit_finish` stops before any other check, or undefined: open blocking findings first, then a missing unit review. */
export async function finishGateRefusal(state: ChangeState, pack: Pack, unit: string, git: Git): Promise<string | undefined> {
	const target = state.change.units.find((u) => u.id === unit);
	if (target === undefined || target.done) return undefined;
	return findingsRefusal(state, unit) ?? (await reviewRefusal(state, pack, unit, git));
}
