// `change_close` steps (design D11): the `close-summary` marker, the refusal rule and the idempotent writes of the
// change issue and its initiative tracking issue. Each step checks its own record or state first.

import type { Change } from "../core/change.ts";
import { parseInitiative } from "../core/initiative.ts";
import { tickChange } from "../core/tick.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { type MarkedComment, readMarkedComments, registerKind, writeMarked } from "../forge/markers.ts";
import type { Forge } from "../forge/types.ts";
import { reviewRounds } from "../review/status.ts";
import { CLOSE_PHASE } from "./phase.ts";
import { writeBodyWithRetry } from "./versioned-write.ts";

export const CLOSE_SUMMARY_KIND = "close-summary";
registerKind(CLOSE_SUMMARY_KIND);

export const INITIATIVE_SUMMARY_ID = "close-summary.initiative";

export type CloseSummary = { pr: number; mergedAt?: string; units: string[]; durableDocs: string[]; reviewRounds: number; abandoned?: string };

export type CloseEvents = { closed: { change: number; pr: number; initiative?: number; abandoned?: true }; initiativeClosed?: { initiative: number; changes: number[] } };

const summaryComment = (id: string, data: CloseSummary): string => writeMarked(CLOSE_SUMMARY_KIND, id, data);
const hasSummary = (marked: MarkedComment[], id: string): boolean => marked.some((m) => m.kind === CLOSE_SUMMARY_KIND && m.id === id);

/** The refusal of `change_close` (nothing is written), or undefined when the change may close. `abandon` is the raw reason. */
export function closeRefusal(state: ChangeState, abandon: string | undefined): string | undefined {
	const pr = state.pr;
	if (abandon !== undefined) {
		if (abandon.trim() === "") return "the abandon reason is empty.";
		if (pr === undefined) return "the change has no readable pull request to abandon.";
		if (pr.state !== "closed" || pr.merged) return `pull request #${pr.number} is not closed without merge; abandon applies only to a closed, unmerged pull request.`;
		return undefined;
	}
	const phase = state.phase.kind === "ok" ? state.phase.id : "no phase";
	if (phase !== CLOSE_PHASE) return `the change is in ${phase}; change_close runs in ${CLOSE_PHASE}.`;
	if (pr === undefined || !pr.merged) return pr === undefined ? "the change has no readable pull request." : `pull request #${pr.number} is not merged; a human merges it on the forge first.`;
	return undefined;
}

/** The summary data of the change, per the `close-summary` contract. */
export function summaryData(state: ChangeState, pr: NonNullable<ChangeState["pr"]>, abandon: string | undefined): CloseSummary {
	return {
		pr: pr.number,
		...(pr.mergedAt === undefined ? {} : { mergedAt: pr.mergedAt }),
		units: state.change.units.map((u) => `${u.id} ${u.done ? "done" : "pending"}`),
		durableDocs: state.change.durableDocs.map((r) => `${r.file} — ${r.status}`),
		reviewRounds: reviewRounds(state.marked, undefined).value,
		...(abandon === undefined ? {} : { abandoned: abandon.trim() }),
	};
}

/** The initiative issue number of the `Initiative: #N` header line. */
export function initiativeNumber(header: Change["header"]): number | undefined {
	const m = /^#(\d+)$/.exec((header.initiative ?? "").trim());
	return m ? Number(m[1]) : undefined;
}

/** Posts the change's `close-summary` unless the issue already carries it. */
export async function postChangeSummary(forge: Forge, state: ChangeState, data: CloseSummary): Promise<void> {
	const id = `close-summary.${state.issue.number}`;
	if (hasSummary(state.marked, id)) return;
	await forge.createComment(state.issue.number, summaryComment(id, data));
}

/** The refusal when the tracking issue does not list the change (read-only; run before any write), else undefined. */
export async function initiativeRefusal(forge: Forge, tracking: number, change: number): Promise<string | undefined> {
	const issue = await forge.getIssue(tracking);
	if (parseInitiative(issue.body).changes.some((c) => c.number === change)) return undefined;
	return `the Initiative line names initiative #${tracking}, which does not list change #${change}; fix the Initiative line or the initiative.`;
}

/** Ticks `change` in the tracking issue's `## Changes` list when unchecked (versioned write, one retry). */
async function tickEntry(forge: Forge, tracking: number, change: number): Promise<string> {
	const written = await writeBodyWithRetry(forge, tracking, (body) => {
		const entry = parseInitiative(body).changes.find((c) => c.number === change);
		if (!entry) throw new Error(`the Initiative line names initiative #${tracking}, which does not list change #${change}`);
		return entry.checked ? undefined : tickChange(body, change);
	});
	if (written.status === "conflict") throw new Error(`initiative #${tracking} kept changing while the change was ticked; call change_close again`);
	return written.body;
}

/** Ticks the entry; closes the tracking issue (after its own summary) once every entry is checked. Returns the initiative-closed event data when its summary exists. */
export async function closeInitiative(forge: Forge, tracking: number, change: number, data: CloseSummary): Promise<CloseEvents["initiativeClosed"]> {
	const body = await tickEntry(forge, tracking, change);
	const changes = parseInitiative(body).changes;
	if (!changes.every((c) => c.checked)) return undefined;
	const { comments } = await readMarkedComments(forge, tracking);
	let summarized = hasSummary(comments, INITIATIVE_SUMMARY_ID);
	if ((await forge.getIssue(tracking)).state === "open") {
		if (!summarized) {
			await forge.createComment(tracking, summaryComment(INITIATIVE_SUMMARY_ID, data));
			summarized = true;
		}
		await forge.closeIssue(tracking);
	}
	return summarized ? { initiative: tracking, changes: changes.map((c) => c.number) } : undefined;
}
