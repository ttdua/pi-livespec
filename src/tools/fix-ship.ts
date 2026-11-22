// `fix_ship` (small-fix-lane "Fix ship tool", design D3): on `fix/<slug>`, once every refusal is false, pushes the
// fix branch through `guardedPush` and opens (or updates) its one pull request, whose body carries the `lane`
// decision block. A fix has no issue: nothing is written anywhere else. The whole call runs under the evidence
// lock, so two parallel calls cannot open two pull requests.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { messageOf } from "../core/messages.ts";
import type { DecisionRecord } from "../decide/records.ts";
import { decide } from "../decide/seam.ts";
import { withEvidenceLock } from "../evidence/lock.ts";
import { runVerify } from "../evidence/runner.ts";
import { verifyEnv } from "../evidence/verify-env.ts";
import { DIRTY_TREE_REFUSAL, fixIntegration, fixRange as gitRange, fixSlug } from "../fix/branch.ts";
import { type LaneOutcome, laneConfigOf } from "../fix/lane.ts";
import { laneFacts } from "../fix/lane-facts.ts";
import { type FixTest, fixPullRequestBody } from "../fix/pr-body.ts";
import type { PullRequest } from "../forge/types.ts";
import { guardedPush } from "../guard/push.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { prepareWrite, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { childRefusal, type ToolCtx } from "./subagent-target.ts";

const TOOL = "fix_ship";
const REMOTE = "origin";
const TEST_TAIL_BYTES = 4096;

export type FixShipDetails = { pr?: number };

type Fix = { w: WriteContext; slug: string; branch: string };
type Range = { integration: string; base: string; subjects: string[] };
type Refused = { refused: string };
/** What the push and the pull request write need, all resolved before the push. */
type Publish = { integration: string; target: PullRequest | undefined; content: { title: string; body: string }; head: string };

const refuse = (message: string): ToolResult<FixShipDetails> => toolResult(`${TOOL} refused: ${message} Nothing was pushed or opened.`, {}, true);
const failed = (message: string): ToolResult<FixShipDetails> => toolResult(`${TOOL} failed: ${message}`, {}, true);
const isRefused = <T extends object>(v: T | Refused): v is Refused => "refused" in v;

/** Refusal 1–2: a fix branch (read-only forge already refused by `prepareWrite`) and a clean tree. */
async function fixRefusal(w: WriteContext): Promise<Fix | Refused> {
	const branch = await w.session.git.branch();
	const slug = fixSlug(branch);
	if (slug === undefined) return { refused: `the current branch ${untrusted(branch)} is not a fix branch fix/<slug>; start one with fix_start.` };
	if (await w.session.git.isDirty()) return { refused: DIRTY_TREE_REFUSAL };
	return { w, slug, branch };
}

/** Refusal 3: the fetch and merge base succeed, and at least one commit follows the merge base. */
async function fixRange(f: Fix): Promise<Range | Refused> {
	const { git, config } = f.w.session;
	const integration = await fixIntegration(config.project, git);
	if (typeof integration !== "string") return integration;
	try {
		const { mergeBase: base, subjects } = await gitRange(git, integration);
		if (subjects.length === 0) return { refused: `there is nothing to ship: ${f.branch} has no commit after the merge base with ${REMOTE}/${integration}; switch back to ${integration}.` };
		return { integration, base, subjects };
	} catch (error) {
		return { refused: `git failed while finding the merge base with ${REMOTE}/${integration}: ${untrusted(messageOf(error))}.` };
	}
}

/** Refusal 4: the `lane` decision; a forced fix lists every reason. The record goes only into the pull request body. */
async function laneDecision(f: Fix, range: Range): Promise<DecisionRecord | Refused> {
	const config = laneConfigOf(f.w.pack);
	if ("invalid" in config) return { refused: `${config.invalid}; set it in .pi/livespec/flow.yaml.` };
	let facts: Awaited<ReturnType<typeof laneFacts>>;
	try {
		facts = await laneFacts(f.w.session.git, f.w.session.cwd, range.base);
	} catch (error) {
		return { refused: `the lane facts could not be built: ${untrusted(messageOf(error))}.` };
	}
	const decided = await decide("lane", facts, { config, subject: f.slug });
	if (decided.status !== "decided") return { refused: "the lane rule asked a question; it must decide on its own." };
	const outcome = decided.outcome as LaneOutcome;
	if (outcome.lane === "forced") {
		const reasons = outcome.reasons.map((r) => `- ${untrusted(r)}`).join("\n");
		return { refused: `the fix is too large for the small-fix lane:\n${reasons}\nMove it into a change with change_new <name> --from-fix.` };
	}
	return { point: "lane", subject: f.slug, source: decided.source, outcome, reason: decided.reason, facts: decided.facts };
}

/** After the test: the same branch and HEAD, and still a clean tree (the test command may have changed them). */
async function unchangedRefusal(f: Fix, head: string): Promise<string | undefined> {
	const git = f.w.session.git;
	const branch = await git.branch();
	if (branch !== f.branch) return `testCommand switched the branch from ${f.branch} to ${untrusted(branch)}; switch back and rerun.`;
	const after = await git.head();
	if (after !== head) return `testCommand moved HEAD from ${head.slice(0, 7)} to ${after.slice(0, 7)}; check the new commit and rerun.`;
	if (await git.isDirty()) return "testCommand left uncommitted changes in the working tree; clean them up and rerun.";
	return undefined;
}

/** Refusals 5–6: `testCommand` is set and exits 0 at the project root through the guard, leaving branch, HEAD and tree as they were. */
async function runTests(f: Fix, signal: AbortSignal | undefined): Promise<FixTest | Refused> {
	const command = f.w.session.config.project?.testCommand;
	if (command === undefined) return { refused: "no test command is configured: set testCommand in .pi/livespec/config.yaml." };
	const env = await verifyEnv(f.w.session, signal);
	const head = await env.git.head();
	const run = await runVerify(command, { ...env.run, cwd: env.root, tailBytes: TEST_TAIL_BYTES });
	if ("blocked" in run) return { refused: `testCommand is blocked: ${run.blocked}` };
	if (run.exit !== 0) {
		const why = run.timedOut ? "timed out" : run.aborted ? "was aborted" : run.spawnError !== undefined ? `failed to start (${run.spawnError})` : `exit ${run.exit}`;
		return { refused: `testCommand \`${untrusted(command)}\` ${why}, output tail:\n${untrusted(run.output)}\n` };
	}
	const changed = await unchangedRefusal(f, head);
	if (changed !== undefined) return { refused: changed };
	return { command, exit: run.exit, head, output: run.output };
}

/** Refusal 7: the one own open pull request from the fix branch (updated), none (created), or a refusal naming them. */
async function pullRequestTarget(f: Fix): Promise<{ pr: PullRequest | undefined } | Refused> {
	const { login } = await f.w.forge.whoami();
	const open = await f.w.forge.listPullRequests({ state: "open", head: f.branch });
	const foreign = open.filter((pr) => pr.author !== login);
	if (foreign.length > 0) return { refused: `pull request ${foreign.map((pr) => `#${pr.number}`).join(", ")} from ${f.branch} was opened by another login; close it or ship from another branch.` };
	if (open.length > 1) return { refused: `more than one pull request is open from ${f.branch} (${open.map((pr) => `#${pr.number}`).join(", ")}); close all but one.` };
	return { pr: open[0] };
}

/** Opens the pull request or updates the read one with its version; the branch is already pushed. */
async function openOrUpdate(f: Fix, p: Publish): Promise<PullRequest | { failed: string }> {
	const { target, content } = p;
	const pushed = `the branch ${f.branch} was pushed, but`;
	try {
		if (target === undefined) return await f.w.forge.createPullRequest({ head: f.branch, base: p.integration, ...content });
		const write = await f.w.forge.updatePullRequest(target.number, content, target.version);
		if (write.status === "written") return write.item;
		return { failed: `${pushed} pull request #${target.number} changed since it was read (${write.changed.join(", ")}); run ${TOOL} again.` };
	} catch (error) {
		const what = target === undefined ? "opening the pull request" : `updating pull request #${target.number}`;
		return { failed: `${pushed} ${what} failed (${untrusted(messageOf(error))}); run ${TOOL} again.` };
	}
}

/** Push, then open or update the pull request. */
async function publish(f: Fix, p: Publish): Promise<ToolResult<FixShipDetails>> {
	try {
		await guardedPush(f.w.session.exec, f.w.session.cwd, REMOTE, `HEAD:refs/heads/${f.branch}`);
	} catch (error) {
		return refuse(`pushing ${f.branch} failed: ${untrusted(messageOf(error))}.`);
	}
	const pr = await openOrUpdate(f, p);
	if ("failed" in pr) return failed(pr.failed);
	const verb = p.target === undefined ? "Opened" : "Updated";
	return toolResult(`Pushed ${f.branch} at ${p.head.slice(0, 7)}. ${verb} pull request #${pr.number}; a human merges it on the forge.`, { pr: pr.number });
}

/** Every refusal in order, then the push and the pull request. */
async function ship(signal: AbortSignal | undefined): Promise<ToolResult<FixShipDetails>> {
	const w = await prepareWrite();
	if (!w.ok) return refuse(w.message);
	const f = await fixRefusal(w);
	if (isRefused(f)) return refuse(f.refused);
	const range = await fixRange(f);
	if (isRefused(range)) return refuse(range.refused);
	const record = await laneDecision(f, range);
	if (isRefused(record)) return refuse(record.refused);
	const test = await runTests(f, signal);
	if (isRefused(test)) return refuse(test.refused);
	const target = await pullRequestTarget(f);
	if (isRefused(target)) return refuse(target.refused);
	const content = fixPullRequestBody({ slug: f.slug, subjects: range.subjects, test, record });
	return publish(f, { integration: range.integration, target: target.pr, content, head: test.head });
}

export function runFixShip(ctx: ToolCtx, signal?: AbortSignal): Promise<ToolResult<FixShipDetails>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return Promise.resolve({ ...child, details: {} });
	return withEvidenceLock(() => ship(signal));
}

export function registerFixShip(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Ship a fix",
		description:
			"Ship the small fix on fix/<slug>: check the lane rule, run testCommand, push the branch to origin and open (or update) its one pull request to the integration branch, with the lane decision in the body. Refuses, pushing nothing, on a dirty tree, a forced lane (move it with change_new <name> --from-fix), failing tests or a pull request from the branch opened by another login.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. No parameter reaches the remote or the refspec.
		parameters: { type: "object", properties: {} } as never,
		execute: (_id, _params, signal, _update, ctx) => runFixShip(ctx as ToolCtx, signal),
	});
}
