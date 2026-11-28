// `change_ship` (ship-phase "Ship tool", design D5): once every refusal is false, pushes the change branch through
// `guardedPush`, opens (or adopts) the one pull request, writes `PR: #<n>` and posts the `ship` record. A stale
// ship approval writes only a `stale` comment listing `ship`. The whole call runs under the evidence lock, so two
// parallel calls cannot open two pull requests: the second sees the `PR:` line and refuses.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { messageOf } from "../core/messages.ts";
import { integrationBranch } from "../engine/git.ts";
import { validApproval } from "../engine/locks.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { withEvidenceLock } from "../evidence/lock.ts";
import type { Comment, PullRequest } from "../forge/types.ts";
import { guardedPush } from "../guard/push.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { staleComment } from "../interaction/stale.ts";
import { reviewPayload } from "../review/payload.ts";
import { type ShipContext, shipContext } from "../ship/context.ts";
import { durableDocsRule } from "../ship/durable-docs.ts";
import { shipStaleness, writerVoices } from "../ship/freshness.ts";
import { SHIP_PHASE } from "../ship/phase.ts";
import { pullRequestBody } from "../ship/pr-body.ts";
import { isReviewed } from "../ship/reviewed.ts";
import { closingCommitsRefusal, filesRefusal, pullRequestChoice, shipLocalRefusal, staleShipId } from "../ship/ship-refusals.ts";
import { postShipRecord, writePrLine } from "../ship/ship-writes.ts";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { withStep } from "./request-flow.ts";
import { childRefusal, type ToolCtx } from "./subagent-target.ts";

const TOOL = "change_ship";
const REMOTE = "origin";
const NO_FACTS = { specsStat: "", specsFiles: [], specsDiff: "" };

type Ship = { w: WriteContext; state: ChangeState; context: ShipContext; branch: string };

const refuse = (message: string): ToolResult<undefined> => toolResult(`${TOOL} refused: ${message} Nothing was pushed or opened.`, undefined, true);
const failed = (message: string): ToolResult<undefined> => toolResult(`${TOOL} failed: ${message}`, undefined, true);

/** The ship gate counts when it has a valid approval and HEAD is reviewed against its `head_sha` (clean merges allowed). */
async function shipGateRefusal(s: Ship): Promise<string | undefined> {
	const gate = s.state.lock.gates[SHIP_PHASE];
	if (!validApproval(gate)) return `the ship gate has no valid approved result: request it with spec_gate ${SHIP_PHASE}.`;
	const atHead = await isReviewed(s.w.session.git, gate?.headSha, s.state.git.head, s.context.integrationTip).catch((error: unknown) => ({ ok: false as const, reason: messageOf(error) }));
	return atHead.ok ? undefined : `the ship gate was approved at another commit: ${atHead.reason}; request the ship gate again.`;
}

/** The git refusals after the local ones: the ship gate, reviewed HEAD, the Files check and closing commit messages. */
async function gitRefusal(s: Ship): Promise<string | undefined> {
	const gate = await shipGateRefusal(s);
	if (gate !== undefined) return gate;
	if (!s.context.reviewed.ok) return `HEAD is not reviewed: ${s.context.reviewed.reason}.`;
	const files = filesRefusal(s.context.diff.files, s.state.change.units);
	if (files !== undefined) return files;
	return closingCommitsRefusal(await s.w.session.git.messages(`${s.context.diff.from}..HEAD`));
}

/** A stale ship approval posts its `stale` comment (once per id) and returns the refusal; undefined when fresh. */
async function freshnessRefusal(s: Ship, login: string): Promise<ToolResult<undefined> | undefined> {
	const n = s.state.issue.number;
	const comments = await s.w.forge.listComments(n);
	const gateCommentId = s.state.lock.gates[SHIP_PHASE]?.commentId;
	const gateComment = comments.find((c) => c.id === gateCommentId);
	let humans: Comment[];
	try {
		humans = await writerVoices(comments, login, (author) => s.w.forge.getPermission(author), gateComment);
	} catch (error) {
		return refuse(`cannot read the permission of a commenter (${untrusted(messageOf(error))}), so freshness cannot be checked.`);
	}
	const staleness = shipStaleness(s.state, gateComment, humans);
	if (staleness === undefined) return undefined;
	if (staleness.kind === "missing") return refuse(`${staleness.reason}; request the ship gate again.`);
	const id = staleShipId(staleness, gateCommentId ?? "");
	if (!s.state.marked.some((m) => m.kind === "stale" && m.id === id)) {
		await s.w.forge.createComment(n, staleComment(id, { reason: staleness.reason, phases: [SHIP_PHASE] }));
		await afterForgeWrite(s.w.session, n);
	}
	return toolResult(withStep(s.w.session, `${TOOL} refused as stale: ${untrusted(staleness.reason)}. A stale comment lists ${SHIP_PHASE}; request the ship gate again. Nothing was pushed or opened.`), undefined, true);
}

/** Opens the pull request from the change branch to the integration branch. */
async function openPullRequest(s: Ship): Promise<PullRequest | { failed: string }> {
	const project = s.w.session.config.project;
	const base = project === null ? undefined : await integrationBranch(project, s.w.session.git);
	if (base === undefined) return { failed: "no integration branch to open the pull request against." };
	const { title, body } = pullRequestBody(s.state, reviewPayload(s.state, NO_FACTS) ?? "");
	try {
		return await s.w.forge.createPullRequest({ head: s.branch, base, title, body });
	} catch (error) {
		return { failed: `the branch ${s.branch} was pushed, but opening the pull request failed (${untrusted(messageOf(error))}); run ${TOOL} again.` };
	}
}

/** Push → open or adopt → `PR:` line → `ship` record. The ledger is pushed first, so origin never holds a branch whose ledger is missing. */
async function publish(s: Ship, adopt: PullRequest | undefined): Promise<ToolResult<undefined>> {
	const n = s.state.issue.number;
	const ledger = await s.w.ledger.sync(n);
	if (ledger.status !== "synced") {
		return refuse(`the ledger could not be pushed: ${ledger.status === "pending" ? ledger.reason : ledger.message}.`);
	}
	try {
		await guardedPush(s.w.session.exec, s.w.session.cwd, REMOTE, `HEAD:refs/heads/${s.branch}`);
	} catch (error) {
		return refuse(`pushing ${s.branch} failed: ${untrusted(messageOf(error))}.`);
	}
	const pr = adopt ?? (await openPullRequest(s));
	if ("failed" in pr) return failed(pr.failed);
	const line = await writePrLine(s.w.forge, n, pr.number);
	if (!line.ok) {
		await afterForgeWrite(s.w.session, n);
		return failed(line.message);
	}
	const record = await postShipRecord(s.w.forge, n, { pr: pr.number, pushedHead: s.state.git.head, confirmed: durableDocsRule(s.context.facts).confirm });
	await afterForgeWrite(s.w.session, n);
	if (!record.ok) return failed(record.message);
	const verb = adopt === undefined ? "Opened" : "Adopted";
	return toolResult(withStep(s.w.session, `Pushed ${s.branch} at ${s.state.git.head.slice(0, 7)}. ${verb} pull request #${pr.number} and recorded PR: #${pr.number} on #${n}.`), undefined);
}

/** Every refusal in order, then the freshness check, the pull request choice and the publish. */
async function ship(): Promise<ToolResult<undefined>> {
	const w = await prepareWrite();
	if (!w.ok) return refuse(w.message);
	const change = requireChange(w.session);
	if (!change.ok) return refuse(change.message);
	const { state } = change;
	const local = shipLocalRefusal(state);
	if (local !== undefined) return refuse(local);
	const context = await shipContext(w.session, state);
	if ("refused" in context) return refuse(context.refused);
	const s: Ship = { w, state, context, branch: state.git.branch };
	const git = await gitRefusal(s);
	if (git !== undefined) return refuse(git);
	const { login } = await w.forge.whoami();
	const stale = await freshnessRefusal(s, login);
	if (stale !== undefined) return stale;
	const choice = pullRequestChoice(await w.forge.listPullRequests({ state: "open", head: s.branch }), { login, change: state.issue.number });
	if (choice.kind === "refused") return refuse(choice.reason);
	return publish(s, choice.kind === "adopt" ? choice.pr : undefined);
}

export function runChangeShip(ctx: ToolCtx): Promise<ToolResult<undefined>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return Promise.resolve(child);
	return withEvidenceLock(ship);
}

export function registerChangeShip(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Ship the change",
		description:
			"Push the change branch and open its one pull request to the integration branch, then record PR: #<n> on the change issue. Runs in ship once the ship gate is approved at HEAD; refuses (pushing nothing) on any unmet condition, and on new human input since the ship gate it marks the ship gate stale.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. No parameter reaches the remote or the refspec.
		parameters: { type: "object", properties: {} } as never,
		execute: (_id, _params, _signal, _update, ctx) => runChangeShip(ctx as ToolCtx),
	});
}
