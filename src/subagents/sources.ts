// Packet sources: the registry of extra providers and the manifest per role and subject.

import { rubricFor } from "./rubrics.ts";
import type { ReviewSubject, Role } from "./roles.ts";
import { makeReads, placed, sha256, type Cx, type Provider, type Reads } from "./source-kit.ts";
import type { PacketContext, Placed, SourceProvider, Target } from "./source-types.ts";
import { answeredQuestions, changeIssue, coveredRequirements, initiativeIssue } from "./sources-change.ts";
import { closedWork, closingSummaries, pullRequestAndChecks, referencedIssues, reviewComments } from "./sources-forge.ts";
import { codeDiff, constraints, declaredSpecs, findingAndCode, owningUnit, productExcerpt, specsDiff } from "./sources-git.ts";
import { personaFile } from "./sources-persona.ts";
import { allReceipts, decisionRecords, dependencyRecords, dispatchAnswers, planGateNotes, receiptsOf, unitFindings } from "./sources-records.ts";

const extra = new Map<Role, SourceProvider[]>();

export function registerPacketSource(role: Role, provider: SourceProvider): void {
	const held = extra.get(role) ?? [];
	if (!held.includes(provider)) extra.set(role, [...held, provider]);
}

export function resetPacketSourcesForTests(): void {
	extra.clear();
}

const IMPLEMENTER: Provider[] = [
	coveredRequirements, constraints, answeredQuestions(false), dispatchAnswers(false), planGateNotes, unitFindings,
	dependencyRecords, referencedIssues, reviewComments(true),
];
const REVIEWER_ALL: Provider[] = [codeDiff, declaredSpecs, constraints, allReceipts, changeIssue("body"), answeredQuestions(true), dispatchAnswers(true), decisionRecords, reviewComments(false), pullRequestAndChecks];
const REVIEW_BASE: Provider[] = [changeIssue("header"), initiativeIssue, declaredSpecs, constraints, closingSummaries];

function manifest(role: Role, subject: ReviewSubject | undefined): Provider[] {
	if (role === "implementer") return IMPLEMENTER;
	if (role === "verifier") return [findingAndCode, owningUnit];
	if (role === "scout") return [initiativeIssue, closedWork];
	if (subject === "spec") return [specsDiff, ...REVIEW_BASE];
	if (subject === "plan") return [changeIssue("units"), specsDiff, ...REVIEW_BASE.slice(1)];
	return subject === "change" || subject?.startsWith("persona:") === true ? [...REVIEWER_ALL, personaFile] : REVIEWER_ALL;
}

const rubric = (subject: ReviewSubject | undefined): Provider[] =>
	subject === undefined ? [] : [{ name: "rubric", run: async () => { const text = rubricFor(subject); return [placed({ id: `file:rubric/${subject.replace(/[^A-Za-z0-9._-]/g, "-")}`, version: sha256(text), title: `Rubric: ${subject}`, text, untrusted: false }, "pinned")]; } }];

async function runProvider(p: { name: string; run(cx: Cx): Promise<Placed[]> }, cx: Cx): Promise<Placed[]> {
	try {
		return await p.run(cx);
	} catch (error) {
		throw new Error(`packet source provider ${p.name} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Registered providers wrap their sources with the order they were registered in. */
function registered(role: Role): Provider[] {
	return (extra.get(role) ?? []).map((fn, i) => ({
		name: fn.name || `registered-${role}-${i + 1}`,
		run: async (cx: Cx) => (await fn(cx.ctx, cx.target)).map((source): Placed => ({ source, place: "inline" })),
	}));
}

/** The required sources of `target` in manifest order, first occurrence of an id wins. A failing provider rejects with its name. */
export async function collectSources(ctx: PacketContext, target: Target, reads: Reads = makeReads(ctx.forge)): Promise<Placed[]> {
	const cx: Cx = { ctx, target, reads };
	const providers = [...manifest(target.role, target.subject), ...rubric(target.role === "reviewer" ? target.subject : undefined), productExcerpt, ...registered(target.role)];
	const out = new Map<string, Placed>();
	for (const p of providers) for (const item of await runProvider(p, cx)) if (!out.has(item.source.id)) out.set(item.source.id, item);
	return [...out.values()];
}
