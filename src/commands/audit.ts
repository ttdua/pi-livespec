// `/livespec audit [#T]`: a read-only drift audit of the fetched integration commit.
// Pipeline: snapshot → detect → confirm → classify → triage → report.

import { type ConfirmDeps, confirmItems } from "../audit/confirm.ts";
import { detectDocs } from "../audit/detect-docs.ts";
import { detectFixes } from "../audit/detect-fixes.ts";
import { detectSpecs } from "../audit/detect-specs.ts";
import type { DriftItem } from "../audit/items.ts";
import { type AuditReport, deliverReport } from "../audit/report.ts";
import { type RepoView, repoViewAt } from "../audit/repo-view.ts";
import { type ClassifiedItem, classify } from "../audit/severity.ts";
import type { AuditState } from "../audit/state.ts";
import { applyTriage, type Triaged } from "../audit/triage.ts";
import { messageOf } from "../core/messages.ts";
import type { Git } from "../engine/git.ts";
import type { Forge } from "../forge/types.ts";
import { untrusted } from "../hooks/phase-card.ts";

export type AuditDeps = {
	git: Git;
	root: string;
	integration: string | undefined;
	forge?: Forge;
	writable: boolean;
	state: AuditState;
	confirm: ConfirmDeps;
	specs: (view: RepoView) => Promise<{ capability: string; paths: string[] }[]>;
	/** The pack's `decisions.drift-severity` entry; the rule's default when absent. */
	severity?: unknown;
};

export type AuditOutcome = { ok: true; text: string; commit: string; posted?: number; fixesRan: boolean } | { ok: false; text: string };

/** Without a fix cursor, the `declared-none` detector looks back this far. */
const FIX_LOOKBACK = "30.days";
const WRITERS: ReadonlySet<string> = new Set(["write", "admin"]);

type Snapshot = { commit: string; refreshed: boolean; fetchError?: string };
type Detected = { items: DriftItem[]; notes: string[]; fixesRan: boolean };

export async function runAudit(deps: AuditDeps, target?: number): Promise<AuditOutcome> {
	const snapshot = await snapshotOf(deps);
	if ("refusal" in snapshot) return { ok: false, text: snapshot.refusal };
	const view = await repoViewAt(deps.git, snapshot.commit);
	const detected = await detect(deps, view);
	const confirmed = await confirmItems(detected.items, snapshot.commit, deps.confirm);
	const classified = await classify(confirmed.kept, deps.severity);
	const destination = target ?? oldestInitiative(deps.state);
	const triaged = await triage(deps, classified, destination);
	const report: AuditReport = {
		...snapshot, ...triaged.result, refuted: confirmed.refuted,
		notes: [...detected.notes, ...(confirmed.note === undefined ? [] : [confirmed.note]), ...triaged.notes],
	};
	const delivered = await deliverReport(report, { ...(deps.forge === undefined ? {} : { forge: deps.forge }), writable: deps.writable, ...(destination === undefined ? {} : { target: destination }) });
	return { ok: true, text: delivered.text, commit: snapshot.commit, fixesRan: detected.fixesRan, ...(delivered.posted === undefined ? {} : { posted: delivered.posted }) };
}

/** Fetches the integration branch; on failure falls back to the local `origin/<integration>`, else refuses. */
async function snapshotOf(deps: AuditDeps): Promise<Snapshot | { refusal: string }> {
	const integration = deps.integration;
	if (integration === undefined) return { refusal: "The audit needs the integration branch: set `integrationBranch` in .pi/livespec/config.yaml or set origin/HEAD. Nothing was posted." };
	const ref = `origin/${integration}`;
	let fetchError: string | undefined;
	try {
		await deps.git.fetch("origin", integration);
	} catch (error) {
		fetchError = messageOf(error);
	}
	const commit = await deps.git.remoteRef(ref);
	if (commit === undefined) return { refusal: `The audit cannot run: there is no ${ref}${fetchError === undefined ? "" : ` and the fetch failed: ${untrusted(fetchError)}`}. Nothing was posted.` };
	return fetchError === undefined ? { commit, refreshed: true } : { commit, refreshed: false, fetchError };
}

/** Every detector over the audited tree; `declared-none` is skipped with a note when the forge cannot be read. */
async function detect(deps: AuditDeps, view: RepoView): Promise<Detected> {
	const items = [...(await detectSpecs(view)), ...(await detectDocs(view))];
	const fixes = await detectFixesAt(deps, view.commit);
	if ("skipped" in fixes) return { items, notes: [`declared-none skipped: ${fixes.skipped}`], fixesRan: false };
	return { items: [...items, ...fixes.items], notes: [], fixesRan: true };
}

async function detectFixesAt(deps: AuditDeps, commit: string): Promise<{ items: DriftItem[] } | { skipped: string }> {
	if (deps.forge === undefined) return { skipped: "no forge is connected" };
	const range = deps.state.fixCursor === undefined ? { since: FIX_LOOKBACK } : { after: deps.state.fixCursor };
	const commits = await deps.git.firstParentCommits(commit, range);
	try {
		return { items: await detectFixes(commits, deps.forge) };
	} catch (error) {
		return { skipped: `the forge could not be read (${untrusted(messageOf(error))})` };
	}
}

const oldestInitiative = (state: AuditState): number | undefined => state.pending.find((p) => p.kind === "initiative")?.initiative;

/** Writer triage commands of the target initiative; without a target or a readable forge the rule's classification stands. */
async function triage(deps: AuditDeps, items: ClassifiedItem[], target: number | undefined): Promise<{ result: Triaged; notes: string[] }> {
	const untouched = { result: { items, ignored: [], unmatched: [] }, notes: [] };
	const forge = deps.forge;
	if (target === undefined || forge === undefined) return untouched;
	try {
		const comments = await forge.listComments(target);
		const canWrite = async (login: string) => WRITERS.has(await forge.getPermission(login).catch(() => "none" as const));
		return { result: await applyTriage(items, comments, canWrite), notes: [] };
	} catch (error) {
		return { ...untouched, notes: [`triage commands on #${target} were not read: ${untrusted(messageOf(error))}`] };
	}
}
