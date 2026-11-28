// One function per review stage (design D2): each does its writes and returns what the tool reports.
// The tool reloads the change state after every stage, so each stage reads the records the previous one posted.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decisionComment } from "../decide/records.ts";
import { decide } from "../decide/seam.ts";
import { diffFilesOf } from "../engine/git.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { verifyEnv } from "../evidence/verify-env.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { type DispatchOutcome, type DispatchRequest, runDispatch } from "../subagents/dispatch.ts";
import { findExecutor } from "../subagents/executor.ts";
import { replayReviewerConclusions } from "../docs/behavior-review.ts";
import { buildPacket, changeName } from "../subagents/packet.ts";
import { readPacket, writePacket } from "../subagents/packet-store.ts";
import { entriesFor } from "../subagents/policy.ts";
import type { ReviewSubject } from "../subagents/roles.ts";
import type { ApproverCtx } from "../tools/approver-for.ts";
import { afterForgeWrite, type WriteContext } from "../tools/guard.ts";
import { runSpecQuestion, type SpecQuestionParams } from "../tools/spec-question.ts";
import { dispatchDeps, dispatchRequest, findingOf, packetContext, type SubagentToolDeps } from "../tools/subagent-request.ts";
import { respawnLine } from "../tools/subagent-outcome.ts";
import { argsOf, type Target, type ToolCtx, warn } from "../tools/subagent-target.ts";
import { mergeFindings, withRoutes } from "./aggregate.ts";
import { applyRoutes, QuestionNotSent, type RouteEffects } from "./effects.ts";
import { fanOut } from "./fanout.ts";
import { aggregateComment, aggregateOf, latestRun, reviewRunComment } from "./records.ts";
import { completedReview, type NextStage, roundNumber } from "./round.ts";
import { CHECK_PREFIX, normalizeLocation, type RouteResult } from "./route.ts";
import { selectSubjects } from "./select.ts";
import { startInputs } from "./start.ts";

export type StageReport = { text: string; inline?: string[]; stop: boolean; error?: boolean };

export type StageCtx = {
	pi: ExtensionAPI;
	w: WriteContext;
	state: ChangeState;
	tool: ToolCtx & ApproverCtx;
	deps: SubagentToolDeps;
	signal?: AbortSignal;
};

const REVIEW = "review";
const COMPLETED = new Set(["DONE", "DONE_WITH_CONCERNS"]);

async function post(c: StageCtx, body: string): Promise<void> {
	await c.w.forge.createComment(c.state.issue.number, body);
	await afterForgeWrite(c.w.session, c.state.issue.number);
}

const baseOf = (state: ChangeState): string => {
	const base = state.change.header.base;
	if (base === undefined) throw new Error("the change has no Base line");
	return base;
};

// --- start ---------------------------------------------------------------------------

async function startStage(c: StageCtx): Promise<StageReport> {
	const env = await verifyEnv(c.w.session, c.signal);
	const inputs = await startInputs({ state: c.state, pack: c.w.pack, env });
	if ("refused" in inputs) return { text: `spec_review refused: ${inputs.refused} Nothing was written.`, stop: true, error: true };
	const round = roundNumber(c.state.marked);
	await post(c, decisionComment({ point: "tags", subject: REVIEW, source: "rule", outcome: inputs.tags, facts: { files: inputs.diffFiles }, reason: `tags the diff's files carry that no unit has: ${inputs.tags.join(", ") || "none"}` }));
	const selected = selectSubjects(c.w.pack, c.state, inputs.tags);
	await post(c, reviewRunComment({ round, head: c.state.git.head, selected, tags: inputs.tags, verify: inputs.verify, parentFindings: inputs.parent, routed: false }));
	const red = Object.entries(inputs.verify).filter(([, v]) => v.verdict !== "green").map(([u, v]) => `${u} ${v.verdict}`);
	return { text: `Started review round ${round} at ${c.state.git.head.slice(0, 7)}: reviewers ${selected.join(", ")}; Verify ${red.length === 0 ? "green for every unit" : red.join(", ")}; ${inputs.parent.length} parent finding(s).`, stop: false };
}

// --- review and verify: fan-out of dispatches ------------------------------------------

/** The `subagent_packet` and `subagent_record` arguments of a run done inline. */
const inlineArgs = (t: Target): string => `subagent_packet ${argsOf(t)}, then subagent_record ${argsOf(t)}`;

/** What one settled run means for the call: recorded and done, or the reason the call stops. */
export function outcomeLine(t: Target, outcome: DispatchOutcome): { line: string; stop: boolean; inline?: string } {
	const settled = settledLine(t, outcome);
	return { ...settled, line: respawnLine(outcome) + settled.line };
}

function settledLine(t: Target, outcome: DispatchOutcome): { line: string; stop: boolean; inline?: string } {
	const args = argsOf(t);
	switch (outcome.kind) {
		case "result":
			return { line: `${args} settled with ${outcome.result.status} and was recorded.`, stop: !COMPLETED.has(outcome.result.status) };
		case "question":
			return { line: `Child ${outcome.id} (${args}) asks: ${untrusted(outcome.text)}\nAnswer it with subagent_answer ${outcome.id} "<answer>", then call spec_review again.`, stop: true };
		case "inline":
		case "sequential":
			return { line: `${args} runs inline: ${outcome.reason}. Run ${inlineArgs(t)}.`, stop: true, inline: inlineArgs(t) };
		case "blocked":
			return { line: `${args} is BLOCKED: ${outcome.reason}.`, stop: true };
		case "stuck":
			return { line: `${args} needs a decision: ${outcome.reason}. Send a stuck report with spec_stuck.`, stop: true };
		case "cancelled":
			return { line: `${args} was cancelled: ${outcome.reason}.`, stop: true };
	}
}

/** Builds every packet first, then launches all runs at once and waits for them. */
async function dispatchAll(c: StageCtx, targets: Target[], label: string): Promise<StageReport> {
	const executor = findExecutor();
	if (!executor.ok) {
		const inline = targets.map(inlineArgs);
		return { text: `No capable subagent executor (missing ${executor.missing.join(", ")}): launched nothing. Run each ${label} inline, one at a time, then call spec_review again:\n${inline.map((l) => `- ${l}`).join("\n")}`, inline, stop: true };
	}
	const requests: { target: Target; request: DispatchRequest }[] = [];
	for (const target of targets) {
		const found = findingOf(c.state, target);
		if (typeof found === "string") return { text: `spec_review: ${found}`, stop: true, error: true };
		const pctx = packetContext(c.w, c.state, undefined, found);
		const built = await buildPacket(pctx, target.role, undefined, target.subject);
		if (!built.ok) return { text: `spec_review: the ${argsOf(target)} packet cannot be built: ${built.message}`, stop: true, error: true };
		await writePacket(pctx.root, changeName(pctx), built.packet);
		requests.push({ target, request: await dispatchRequest(c.w, c.state, target, built.packet, c.deps) });
	}
	const d = { ...dispatchDeps(c.pi, c.w, c.state.issue.number, executor.service, warn(c.tool)), ...(c.signal === undefined ? {} : { signal: c.signal }) };
	const settled = await fanOut(requests.map((r) => () => runDispatch(d, r.request)), c.signal);
	const lines = settled.map((s, i) => {
		const t = (requests[i] as { target: Target }).target;
		return s.status === "fulfilled" ? outcomeLine(t, s.value) : { line: `${argsOf(t)} failed: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}.`, stop: true };
	});
	const inline = lines.flatMap((l) => (l.inline === undefined ? [] : [l.inline]));
	const cancelled = settled.some((s) => s.status === "fulfilled" && s.value.kind === "cancelled");
	return { text: lines.map((l) => l.line).join("\n"), ...(inline.length === 0 ? {} : { inline }), stop: lines.some((l) => l.stop), ...(cancelled ? { error: true } : {}) };
}

function reviewStage(c: StageCtx, missing: ReviewSubject[]): Promise<StageReport> {
	return dispatchAll(c, missing.map((subject) => ({ role: "reviewer", subject })), "reviewer");
}

function verifyStage(c: StageCtx, missing: string[]): Promise<StageReport> {
	return dispatchAll(c, missing.map((finding) => ({ role: "verifier", finding })), "verifier");
}

// --- aggregate -----------------------------------------------------------------------

const verifierOff = (c: StageCtx): boolean => entriesFor(c.w.pack, REVIEW).some((e) => e.role === "verifier" && e.mode === "off");

/**
 * Re-posts the `reviewer` behavior records of the completed `change` summary that a failed write lost, before the
 * round is aggregated: the summary stores its cleaned entries and the packet its effective conclusions.
 */
async function replayLostConclusions(c: StageCtx, head: string): Promise<void> {
	const summary = completedReview(c.state.marked, "change", head);
	if (summary === undefined) return;
	const pctx = packetContext(c.w, c.state, undefined);
	const packet = await readPacket(pctx.root, changeName(pctx), summary.data.packet);
	const posted = await replayReviewerConclusions((body) => c.w.forge.createComment(c.state.issue.number, body).then(() => undefined), c.state.marked, summary, packet);
	if (posted > 0) await afterForgeWrite(c.w.session, c.state.issue.number);
}

async function aggregateStage(c: StageCtx): Promise<StageReport> {
	const run = latestRun(c.state.marked);
	if (run === undefined) throw new Error("no review-run record to aggregate");
	if (run.selected.includes("change")) await replayLostConclusions(c, run.head);
	const reviews = run.selected.flatMap((s) => {
		const r = completedReview(c.state.marked, s, run.head);
		return r === undefined ? [] : [{ commentId: r.commentId, findings: r.data.findings }];
	});
	const merged = mergeFindings({ parent: run.parentFindings, reviews }, { keepParents: run.source === "pull-request" });
	const base = baseOf(c.state);
	let diffFiles: string[];
	try {
		diffFiles = diffFilesOf(await c.w.session.git.diffNameStatus(base, run.head));
	} catch (error) {
		return { text: `spec_review refused: git diff ${base}..${run.head} failed: ${error instanceof Error ? error.message : String(error)}. Nothing was written.`, stop: true, error: true };
	}
	const units = c.state.change.units.map((u) => ({ id: u.id, files: u.files }));
	const subject = `review-${run.round}`;
	const routes: RouteResult[] = [];
	for (const finding of merged) {
		const check = finding.location.startsWith(CHECK_PREFIX);
		const path = check ? finding.location : normalizeLocation(finding.location).path;
		const facts = { finding, path, units, diffFiles, needsDecision: finding.needsDecision, check };
		const decided = await decide("finding-scope", facts, { config: c.w.pack.decisions["finding-scope"], subject });
		if (decided.status !== "decided") throw new Error("the finding-scope rule never asks");
		routes.push(decided.outcome as RouteResult);
	}
	const outcome = Object.fromEntries(routes.map((r, i) => [String(i), r]));
	await post(c, decisionComment({ point: "finding-scope", subject, source: "rule", outcome, facts: { diffFiles, units }, reason: "routes from the finding's location, the units' Files and the diff" }));
	const findings = withRoutes(merged, routes, verifierOff(c));
	await post(c, aggregateComment({ round: run.round, head: run.head, reviews: reviews.map((r) => r.commentId), findings }));
	const summary = findings.map((f, i) => `${i}: ${f.severity} ${untrusted(f.kind)} at ${untrusted(f.location)} → ${f.route}${f.routeUnit === undefined ? "" : ` ${f.routeUnit}`} (verify ${f.verify})`);
	return { text: `Aggregated review round ${run.round}: ${findings.length} finding(s).${summary.length === 0 ? "" : `\n${summary.join("\n")}`}`, stop: false };
}

// --- route ---------------------------------------------------------------------------

/** Livespec's own question: non-blocking through `origin: "routing"`; the error text, if any. */
async function routingQuestion(c: StageCtx, p: SpecQuestionParams): Promise<string | undefined> {
	const result = await runSpecQuestion(p, c.tool, { origin: "routing" });
	return result.isError ? result.content.map((x) => x.text).join("\n") : undefined;
}

async function routeStage(c: StageCtx): Promise<StageReport> {
	const run = latestRun(c.state.marked);
	const aggregate = run === undefined ? undefined : aggregateOf(c.state.marked, run.round);
	if (run === undefined || aggregate === undefined) throw new Error("no aggregate to route");
	const issue = c.state.issue.number;
	let effects: RouteEffects;
	try {
		effects = await applyRoutes({
			forge: c.w.forge, issue, branch: c.state.change.header.branch,
			ask: (p) => routingQuestion(c, p),
			reask: (p) => routingQuestion(c, p),
			afterWrite: () => afterForgeWrite(c.w.session, issue),
		}, c.state, aggregate, { postReviewComments: run.source !== "pull-request" });
	} catch (error) {
		if (!(error instanceof QuestionNotSent)) throw error;
		const done = error.effects.posted.length === 0 ? "" : ` Applied: ${error.effects.posted.join(", ")}.`;
		return { text: `Route of review round ${run.round} is not complete, so it is not marked routed:${done}\n${error.errors.join("\n")}\nCall spec_review again to finish it.`, stop: true, error: true };
	}
	const prComments = effects.posted.filter((p) => p.startsWith("pr ")).map((p) => p.slice(3));
	const { commentId: _, ...data } = run;
	await post(c, reviewRunComment({ ...data, routed: true, ...(prComments.length === 0 ? {} : { prComments }) }));
	const rejected = effects.rejected.length === 0 ? "" : `\nThe forge rejected these pull request comments; they stay in the aggregate only: ${effects.rejected.join(", ")}.`;
	return { text: `Routed review round ${run.round}: ${effects.posted.length === 0 ? "no effect needed" : effects.posted.join(", ")}.${rejected}`, stop: false };
}

/** Runs one stage of the round; `done` and `refused` are reported by the tool itself. */
export function runStage(stage: NextStage, c: StageCtx): Promise<StageReport> {
	switch (stage.stage) {
		case "start":
			return startStage(c);
		case "review":
			return reviewStage(c, (stage.missing ?? []) as ReviewSubject[]);
		case "aggregate":
			return aggregateStage(c);
		case "verify":
			return verifyStage(c, (stage.missing ?? []) as string[]);
		case "route":
			return routeStage(c);
		case "done":
		case "refused":
			throw new Error(`stage ${stage.stage} has no stage function`);
	}
}
