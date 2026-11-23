// `change_resume #N` (design D14, spec discovered-dependencies "Resume tool"): on #N's change branch, once
// every change the `parked` record waits for (and the change still depends on) is merged, run the
// `change_sync` steps, merge each wip branch of the record with `--no-ff` in unit order (skipping heads
// already merged), delete the merged remote wip branches through the guarded lease delete, then drop the
// label and post the resume record. A wip merge conflict is aborted and the change stays parked; a failed
// delete refuses and a rerun completes it. It pushes nothing else.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parkedComment, wipBranch } from "../deps/parked.ts";
import type { ParkedUnit } from "../engine/deps-facts.ts";
import { type Git, GitError } from "../engine/git.ts";
import type { ParkedCore } from "../engine/parked.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { withEvidenceLock } from "../evidence/lock.ts";
import { LABEL_PARKED } from "../forge/labels.ts";
import { guardedDeleteWip } from "../guard/push.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { changeDependencies, DependencyReadError } from "../initiatives/readiness.ts";
import { syncChange } from "../initiatives/sync.ts";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { withStep } from "./request-flow.ts";
import { childRefusal, type ToolCtx } from "./subagent-target.ts";

export type ChangeResumeParams = { issue: number };
export type ChangeResumeDetails = { merged?: string[]; deleted?: string[]; kept?: string[] };

const TOOL = "change_resume";
const REMOTE = "origin";

type WipBranch = Required<Pick<ParkedUnit, "unit" | "branch" | "head">>;

const refuse = (message: string): ToolResult<ChangeResumeDetails> => toolResult(`${TOOL} refused: ${message}`, {}, true);

// --- refusals --------------------------------------------------------------------

function stateRefusal(state: ChangeState, issue: number): string | undefined {
	const n = state.issue.number;
	if (issue !== n) return `run it on #${issue}'s change branch; this branch belongs to #${n}.`;
	if (state.stale) return "the change state is stale (forge unreachable or login unknown); retry when the forge is reachable.";
	if (state.parkedCore === undefined) return `#${n} is not parked.`;
	if (state.git.dirty) return "the working tree has uncommitted changes; commit or stash them, then rerun.";
	return undefined;
}

/** The changes the record waits for that #N still depends on, read fresh; a dependency not merged refuses and is named. */
async function waitRefusal(w: WriteContext, state: ChangeState, core: ParkedCore): Promise<string | undefined> {
	try {
		const deps = await changeDependencies(w.forge, { issue: { number: state.issue.number }, change: state.change });
		const unmet = deps.filter((d) => core.waitsFor.includes(d.number) && d.state !== "merged");
		if (unmet.length === 0) return undefined;
		return `#${state.issue.number} still waits for ${unmet.map((d) => `#${d.number} ${d.state}`).join(", ")}; a human runs change_resume #${state.issue.number} once ${unmet.length === 1 ? "it merges" : "they merge"}.`;
	} catch (error) {
		if (!(error instanceof DependencyReadError)) throw error;
		return `#${error.number}, a dependency of #${state.issue.number}, cannot be read fresh from the forge; retry once it can be read.`;
	}
}

// --- wip merges ----------------------------------------------------------------------

const wipBranches = (core: ParkedCore): WipBranch[] => core.units.flatMap((u) => (u.branch === undefined || u.head === undefined ? [] : [{ unit: u.unit, branch: u.branch, head: u.head }]));

/** The ref to merge: the local wip branch when it is at the recorded head, else the head fetched from origin. */
async function mergeRef(git: Git, wip: WipBranch): Promise<string> {
	if ((await git.branchExists(wip.branch)) && (await git.revParse(wip.branch)) === wip.head) return wip.branch;
	await git.fetch(REMOTE, wip.branch);
	return wip.head;
}

/** Whether HEAD already contains `head`; a head git does not know yet (not fetched) is not merged. */
async function isMerged(git: Git, head: string): Promise<boolean> {
	try {
		return await git.isAncestor(head, "HEAD");
	} catch (error) {
		if (error instanceof GitError) return false;
		throw error;
	}
}

/** Merges each wip head not yet in HEAD, in unit order; a conflict is aborted and refused, naming the branch. */
async function mergeWips(git: Git, core: ParkedCore): Promise<{ merged: string[] } | { refused: string }> {
	const merged: string[] = [];
	for (const wip of wipBranches(core)) {
		if (await isMerged(git, wip.head)) continue;
		if ((await git.merge(await mergeRef(git, wip))) === "conflict") {
			await git.mergeAbort();
			const done = merged.length === 0 ? "" : ` ${merged.map(untrusted).join(", ")} ${merged.length === 1 ? "is" : "are"} merged and kept.`;
			return { refused: `merging ${untrusted(wip.branch)} conflicts; the merge was aborted and the change stays parked.${done} Merge ${untrusted(wip.branch)} by hand, resolve the conflicts and commit, then rerun change_resume.` };
		}
		merged.push(wip.branch);
	}
	return { merged };
}

// --- remote wip deletes ---------------------------------------------------------------

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
type Kept = { branch: string; reason: string };

/** Whether the record entry is the wip branch this change would have pushed for the unit, at a well-formed head. */
function isChangeWip(state: ChangeState, wip: WipBranch): boolean {
	const line = state.change.header.branch;
	return line !== undefined && state.change.units.some((u) => u.id === wip.unit) && wip.branch === wipBranch(line, wip.unit) && OBJECT_ID.test(wip.head);
}

/** Deletes each recorded remote wip branch still at its recorded head; a thrown git failure refuses so a rerun finishes. */
async function deleteWips(w: WriteContext, state: ChangeState, core: ParkedCore): Promise<{ deleted: string[]; kept: Kept[] } | { refused: string }> {
	const deleted: string[] = [];
	const kept: Kept[] = [];
	for (const wip of wipBranches(core)) {
		if (!isChangeWip(state, wip)) {
			kept.push({ branch: wip.branch, reason: "not a wip branch of this change" });
			continue;
		}
		try {
			const outcome = await guardedDeleteWip(w.session.exec, w.session.cwd, wip.branch, wip.head);
			if (outcome === "moved") kept.push({ branch: wip.branch, reason: "head moved since the park" });
			else deleted.push(wip.branch);
		} catch (error) {
			if (!(error instanceof GitError)) throw error;
			const done = deleted.length === 0 ? "" : `, ${deleted.map(untrusted).join(", ")} ${deleted.length === 1 ? "is" : "are"} deleted`;
			return { refused: `deleting ${untrusted(wip.branch)} on ${REMOTE} failed (${untrusted(error.message)}); the change stays parked${done}. Fix the cause and rerun change_resume.` };
		}
	}
	return { deleted, kept };
}

// --- the resume ------------------------------------------------------------------------

async function resume(w: WriteContext, state: ChangeState, core: ParkedCore, signal?: AbortSignal): Promise<ToolResult<ChangeResumeDetails>> {
	const n = state.issue.number;
	const synced = await syncChange({ session: w.session, forge: w.forge, state, ...(signal ? { signal } : {}) });
	if ("refused" in synced) {
		await afterForgeWrite(w.session, n);
		return refuse(`${synced.refused} The change stays parked.`);
	}
	const wips = await mergeWips(w.session.git, core);
	if ("refused" in wips) {
		await afterForgeWrite(w.session, n);
		return refuse(wips.refused);
	}
	const removal = await deleteWips(w, state, core);
	if ("refused" in removal) {
		await afterForgeWrite(w.session, n);
		return refuse(removal.refused);
	}
	// The label goes first: the resume record ends the parked state, so a crash between the two leaves a
	// rerun that still sees the change parked and completes both.
	if (state.issue.labels.includes(LABEL_PARKED)) await w.forge.removeLabels(n, [LABEL_PARKED]);
	await w.forge.createComment(n, parkedComment({ resumed: true, at: new Date().toISOString() }));
	await afterForgeWrite(w.session, n);
	const stale = synced.stale.length === 0 ? "" : ` ${synced.stale.join(", ")} regressed or cover a changed requirement, so they are unticked and stale.`;
	const merged = wips.merged.length === 0 ? "no wip branch was left to merge" : `merged ${wips.merged.map(untrusted).join(", ")}`;
	const gone = removal.deleted.length === 0 ? "" : ` Deleted remote ${removal.deleted.map(untrusted).join(", ")}.`;
	const left = removal.kept.length === 0 ? "" : ` Kept on origin: ${removal.kept.map((k) => `${untrusted(k.branch)} (${k.reason})`).join(", ")}.`;
	const details = { merged: wips.merged, deleted: removal.deleted, kept: removal.kept.map((k) => k.branch) };
	return toolResult(withStep(w.session, `Resumed #${n} on Base ${synced.base}: ${merged}.${stale}${gone}${left}`), details);
}

export async function runChangeResume(params: ChangeResumeParams, ctx: ToolCtx, signal?: AbortSignal): Promise<ToolResult<ChangeResumeDetails>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return { ...child, details: {} };
	return withEvidenceLock(async () => {
		const w = await prepareWrite();
		if (!w.ok) return refuse(w.message);
		const change = requireChange(w.session);
		if (!change.ok) return refuse(change.message);
		const { state } = change;
		const refused = stateRefusal(state, params.issue);
		if (refused !== undefined) return refuse(refused);
		const core = state.parkedCore as ParkedCore;
		const waiting = await waitRefusal(w, state, core);
		if (waiting !== undefined) return refuse(waiting);
		return resume(w, state, core, signal);
	});
}

export function registerChangeResume(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Resume a parked livespec change",
		description:
			"Resume parked change #N on its branch once every change it waits for is merged: sync with the integration branch (Base, regression record, stale units), merge each wip branch of the park in unit order, delete the merged remote wip branches (lease-protected, a moved branch is kept), remove livespec:parked and record the resume. Refuses on a dirty tree, an unmerged prerequisite, a wip merge conflict (aborted) or a failed remote delete (rerun completes it).",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: { type: "object", properties: { issue: { type: "number" } }, required: ["issue"] } as never,
		execute: (_id, params, signal, _update, ctx) => runChangeResume(params as ChangeResumeParams, ctx as ToolCtx, signal),
	});
}
