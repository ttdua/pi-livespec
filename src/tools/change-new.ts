// `change_new <name>`: creates only the change issue, in the first phase, with
// the fixed body template. It never creates a branch.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { messageOf } from "../core/messages.ts";
import { isKebabName } from "../core/names.ts";
import { replaceSection, setHeaderLine } from "../core/sections.ts";
import { CHANGE_BRANCH_PREFIX as CHANGE_PREFIX } from "../engine/resolve-change.ts";
import { DIRTY_TREE_REFUSAL, fixEmptyReason, fixIntegration, fixRange, fixSlug } from "../fix/branch.ts";
import { LABEL_LIVESPEC, phaseLabel } from "../forge/labels.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { livespecBaseKey } from "./change-start.ts";
import { afterForgeWrite, prepareWrite, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { childRefusal, type ToolCtx } from "./subagent-target.ts";

export type ChangeNewParams = { name: string; from_fix?: boolean };
export type ChangeNewDetails = { number?: number; branch?: string };

const FIRST_PHASE = "shape";
const MOVED_PHASE = "define";

export const CHANGE_BODY_TEMPLATE = [
	"Depends: —",
	"Capabilities: new [], modified []",
	"Product impact: —",
	"",
	"## Proposal",
	"",
	"## Design",
	"",
	"## Questions",
	"",
	"## Units",
	"",
	"## Durable docs",
	"",
].join("\n");

/** `Depends:` line value: `#a, #b`, or `—` without dependencies. */
export function dependsValue(depends: number[]): string {
	return depends.length === 0 ? "—" : depends.map((d) => `#${d}`).join(", ");
}

/** The template with an `Initiative` line (when given), the `Depends` line and the short Proposal. */
export function changeBody(o: { initiative?: number; depends: number[]; proposal: string }): string {
	const withDepends = setHeaderLine(CHANGE_BODY_TEMPLATE, "Depends", dependsValue(o.depends));
	const head = o.initiative === undefined ? withDepends : `Initiative: #${o.initiative}\n${withDepends}`;
	return replaceSection(head, "Proposal", o.proposal);
}

/** A fix branch ready to move: its slug, merge base and commit subjects. */
type Moving = { slug: string; branch: string; base: string; subjects: string[] };
type Refused = { refused: string };
const isRefused = (v: Moving | Refused): v is Refused => "refused" in v;
const refuseMove = (message: string): ToolResult<ChangeNewDetails> => toolResult(`change_new refused: ${message} Nothing was created.`, {}, true);

/** Every refusal of "Move a fix into a change", in spec order, before anything is written. */
async function fromFixRefusal(w: WriteContext, name: string): Promise<Moving | Refused> {
	const { git, config } = w.session;
	const branch = await git.branch();
	const slug = fixSlug(branch);
	if (slug === undefined) return { refused: `the current branch ${untrusted(branch)} is not a fix branch fix/<slug>; --from-fix moves a fix into a change.` };
	if (await git.isDirty()) return { refused: DIRTY_TREE_REFUSAL };
	const target = `${CHANGE_PREFIX}${name}`;
	if (await git.branchExists(target)) return { refused: `the local branch ${target} already exists.` };
	const integration = await fixIntegration(config.project, git);
	if (typeof integration !== "string") return integration;
	let found: Awaited<ReturnType<typeof fixRange>>;
	try {
		found = await fixRange(git, integration);
	} catch (error) {
		return { refused: `git failed while finding the merge base with origin/${integration}: ${untrusted(messageOf(error))}.` };
	}
	if (found.empty) return { refused: `there is nothing to move: ${fixEmptyReason(branch, integration)}; switch back to ${integration}.` };
	const open = await w.forge.listPullRequests({ state: "open", head: branch });
	if (open.length > 0) return { refused: `pull request ${open.map((pr) => `#${pr.number}`).join(", ")} from ${branch} is open; close it first.` };
	return { slug, branch, base: found.mergeBase, subjects: found.subjects };
}

/** The change issue of a moved fix: the template with `Branch`, `Base` and the commit subjects as Proposal. */
async function createMovedIssue(w: WriteContext, name: string, m: Moving) {
	const header = setHeaderLine(setHeaderLine(CHANGE_BODY_TEMPLATE, "Branch", `${CHANGE_PREFIX}${name}`), "Base", m.base);
	const proposal = [`Moved from ${m.branch}:`, ...m.subjects.map((s) => `- ${s}`)].join("\n");
	const body = replaceSection(header, "Proposal", proposal);
	return w.forge.createIssue({ title: name, body, labels: [LABEL_LIVESPEC, phaseLabel(MOVED_PHASE)] });
}

/** Renames the fix branch and records its base; a failure names the issue and the step still to run by hand. */
async function moveBranch(w: WriteContext, name: string, m: Moving, n: number): Promise<string | undefined> {
	const { git } = w.session;
	const target = `${CHANGE_PREFIX}${name}`;
	const rename = `git branch -m ${m.branch} ${target}`;
	const config = `git config ${livespecBaseKey(target)} ${m.base}`;
	try {
		await git.renameBranch(m.branch, target);
	} catch (error) {
		return `change #${n} was created, but renaming the branch failed (${untrusted(messageOf(error))}). Run: ${rename} && ${config}`;
	}
	try {
		await git.configSet(livespecBaseKey(target), m.base);
	} catch (error) {
		return `change #${n} was created and the branch renamed to ${target}, but recording its base failed (${untrusted(messageOf(error))}). Run: ${config}`;
	}
	return undefined;
}

async function runChangeNewFromFix(w: WriteContext, name: string): Promise<ToolResult<ChangeNewDetails>> {
	const m = await fromFixRefusal(w, name);
	if (isRefused(m)) return refuseMove(m.refused);
	const issue = await createMovedIssue(w, name, m);
	const failure = await moveBranch(w, name, m, issue.number);
	await afterForgeWrite(w.session, issue.number);
	if (failure !== undefined) return toolResult(`change_new failed: ${failure}`, { number: issue.number }, true);
	const branch = `${CHANGE_PREFIX}${name}`;
	return toolResult(`Created change #${issue.number} ${name} in ${MOVED_PHASE} and moved ${m.branch} to ${branch}, keeping its commits (${m.subjects.length} commit subject(s) in the Proposal).`, { number: issue.number, branch });
}

export async function runChangeNew(p: ChangeNewParams, ctx: ToolCtx): Promise<ToolResult<ChangeNewDetails>> {
	// Moving a fix renames a branch, like fix_start and fix_ship: never from a child session.
	const child = p.from_fix === true ? childRefusal("change_new", ctx) : undefined;
	if (child) return { ...child, details: {} };
	if (!isKebabName(p.name)) {
		return toolResult(`The change name must be kebab-case (a-z, 0-9, single hyphens): got "${p.name}".`, {}, true);
	}
	const w = await prepareWrite();
	if (!w.ok) return toolResult(w.message, {}, true);
	const open = await w.forge.searchIssues({ labels: [LABEL_LIVESPEC], state: "open" });
	const taken = open.find((i) => i.title === p.name);
	if (taken) return toolResult(`An open livespec change is already named ${p.name}: #${taken.number}. Nothing was created.`, {}, true);
	if (p.from_fix === true) return runChangeNewFromFix(w, p.name);
	const issue = await w.forge.createIssue({ title: p.name, body: CHANGE_BODY_TEMPLATE, labels: [LABEL_LIVESPEC, phaseLabel(FIRST_PHASE)] });
	await afterForgeWrite(w.session, issue.number);
	return toolResult(`Created change #${issue.number} ${p.name} in ${FIRST_PHASE}. Run change_start #${issue.number} to create its branch.`, {
		number: issue.number,
	});
}

export function registerChangeNew(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: "change_new",
		label: "New livespec change",
		description:
			"Create a livespec change issue named by a kebab-case name, in the shape phase, with the empty change template. It creates no branch; run change_start afterwards. With from_fix, instead turn the current fix/<slug> branch into the change (define phase, branch renamed to livespec/<name>).",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "kebab-case change name, e.g. rate-limit" },
				from_fix: {
					type: "boolean",
					description:
						"Move the current fix/<slug> branch into this change: creates the issue in define with the fix's commit subjects as Proposal, renames the branch to livespec/<name> keeping every commit. Refuses on a dirty tree or an open pull request from the fix.",
				},
			},
			required: ["name"],
		} as never,
		execute: (_id, params, _signal, _update, ctx) => runChangeNew(params as ChangeNewParams, ctx as ToolCtx),
	});
}
