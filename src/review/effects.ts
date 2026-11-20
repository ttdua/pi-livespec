// Idempotent route effects (design D6, D7): a `unit` finding posts its `rebuild` marker and then unticks the unit,
// a `question` finding raises one non-blocking question, and every non-`DISPUTED` finding but `record` becomes
// one pull request review comment when a pull request is open. Each effect is skipped when already applied.

import { parseChange } from "../core/change.ts";
import { untickUnit } from "../core/tick.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { rebuildComment } from "../evidence/records.ts";
import type { Forge } from "../forge/types.ts";
import { type AggregateFinding, type FindingSummaryData, findingKey } from "../subagents/records.ts";
import { normalizeLocation } from "./route.ts";
import { findingState } from "./status.ts";

export type Aggregate = { commentId: string; data: FindingSummaryData };

export type EffectDeps = {
	forge: Pick<Forge, "getIssue" | "updateIssueBody" | "createComment" | "listPullRequests" | "listReviewComments" | "createReviewComment">;
	issue: number;
	/** The change branch, whose open pull request gets the review comments. */
	branch: string | undefined;
	/** Raises `text` as a non-blocking question (`spec_question`); returns the tool's error text, if any. */
	ask(text: string): Promise<string | undefined>;
	/** Called after each own write, so later reads see it. */
	afterWrite(): Promise<void>;
};

/**
 * `posted`: one entry per effect applied now (`rebuild.<unit>.<round>`, `untick <unit>`, `question <key>`,
 * `pr <key>`); `rejected`: the keys the forge refused as pull request comments.
 */
export type RouteEffects = { posted: string[]; rejected: string[] };

/** The hidden marker a pull request comment carries, so a retried stage finds it. */
export const prMarker = (key: string): string => `<!-- livespec:finding ${key} -->`;

/** One version-checked body write; a concurrent edit gets one retry over a fresh read. */
const UNTICK_TRIES = 2;

async function postOnce(deps: EffectDeps, state: ChangeState, id: string, body: string, out: RouteEffects): Promise<void> {
	if (out.posted.includes(id) || state.marked.some((m) => m.kind === "rebuild" && m.id === id)) return;
	await deps.forge.createComment(deps.issue, body);
	await deps.afterWrite();
	out.posted.push(id);
}

async function untick(deps: EffectDeps, unit: string, out: RouteEffects): Promise<void> {
	for (let i = 0; i < UNTICK_TRIES; i++) {
		const issue = await deps.forge.getIssue(deps.issue);
		if (parseChange(issue.body).units.find((u) => u.id === unit)?.done !== true) return;
		const written = await deps.forge.updateIssueBody(deps.issue, untickUnit(issue.body, unit), issue.version);
		if (written.status === "written") {
			await deps.afterWrite();
			out.posted.push(`untick ${unit}`);
			return;
		}
	}
	throw new Error(`the issue body changed twice while ${unit} was unticked; run spec_review again`);
}

/** The rebuild marker first, then the untick: a crash between them leaves a marker the next call completes. */
async function routeToUnit(deps: EffectDeps, state: ChangeState, round: number, key: string, f: AggregateFinding, out: RouteEffects): Promise<void> {
	if (f.routeUnit === undefined) return;
	await postOnce(deps, state, `rebuild.${f.routeUnit}.${round}`, rebuildComment({ unit: f.routeUnit, round, finding: key }), out);
	await untick(deps, f.routeUnit, out);
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

async function raiseQuestion(deps: EffectDeps, key: string, f: AggregateFinding, out: RouteEffects): Promise<string | undefined> {
	const ref = `finding:${key}`;
	const body = (await deps.forge.getIssue(deps.issue)).body;
	if (parseChange(body).questions.some((q) => q.text.includes(ref))) return undefined;
	const error = await deps.ask(oneLine(`Review ${ref} needs a decision: ${f.severity} ${f.kind} at ${f.location}. Proposed fix: ${f.fix}`));
	out.posted.push(`question ${key}`);
	return error;
}

function prBody(key: string, f: AggregateFinding): string {
	return `${prMarker(key)}\n**${f.severity} ${f.kind}** (${f.route}${f.routeUnit === undefined ? "" : ` ${f.routeUnit}`})\n\n${f.evidence}\n\nFix: ${f.fix}`;
}

/** Pull request comments for `items`, skipping keys whose marker is present; a refused comment is reported. */
async function postPrComments(deps: EffectDeps, items: { key: string; finding: AggregateFinding }[], out: RouteEffects): Promise<void> {
	if (deps.branch === undefined || items.length === 0) return;
	const pr = (await deps.forge.listPullRequests({ state: "open", head: deps.branch }))[0];
	if (pr === undefined) return;
	const existing = (await deps.forge.listReviewComments(pr.number)).map((c) => c.body);
	for (const { key, finding } of items) {
		if (existing.some((b) => b.includes(prMarker(key)))) continue;
		const { path, line } = normalizeLocation(finding.location);
		try {
			await deps.forge.createReviewComment(pr.number, { path, line, body: prBody(key, finding) });
			out.posted.push(`pr ${key}`);
		} catch {
			out.rejected.push(key);
		}
	}
}

/** Applies the route effects of every non-`DISPUTED` finding of `aggregate`; question errors are thrown after the rest. */
export async function applyRoutes(deps: EffectDeps, state: ChangeState, aggregate: Aggregate): Promise<RouteEffects> {
	const out: RouteEffects = { posted: [], rejected: [] };
	const round = aggregate.data.round;
	const live = (aggregate.data.findings as AggregateFinding[])
		.map((finding, index) => ({ key: findingKey(aggregate.commentId, index), index, finding }))
		.filter((x) => findingState(state.marked, aggregate.commentId, x.index, state.change.questions) !== "disputed");
	const errors: string[] = [];
	for (const { key, finding } of live) {
		if (finding.route === "unit") await routeToUnit(deps, state, round, key, finding, out);
		if (finding.route === "question") {
			const error = await raiseQuestion(deps, key, finding, out);
			if (error !== undefined) errors.push(error);
		}
	}
	await postPrComments(deps, live.filter((x) => x.finding.route !== "record"), out);
	if (errors.length > 0) throw new Error(`a review question was added but not sent: ${errors.join("; ")}`);
	return out;
}
