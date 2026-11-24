// One runner per `/livespec` subcommand. Each runs its command module and turns
// the result into a `Reply`; the extension only routes and shows replies.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readAuditState } from "../audit/state.ts";
import { auditAndSave } from "../audit/suggest.ts";
import { integrationBranch } from "../engine/git.ts";
import type { Session } from "../hooks/session.ts";
import { forgeWritable } from "../tools/approver-for.ts";
import { defaultSubagentDeps, exclusionsOf } from "../tools/subagent-request.ts";
import { findExecutor } from "../subagents/executor.ts";
import type { EventsLike } from "../subagents/launch.ts";
import { runAccountCommand } from "./account.ts";
import { type AuditDeps, type AuditOutcome, runAudit } from "./audit.ts";
import { type CommandEnv, doctorDeps, initDeps, sessionFor, skillsDeps } from "./deps.ts";
import { formatDoctor, runDoctor } from "./doctor.ts";
import { type InitReport, runInit } from "./init.ts";
import { messageOf } from "./messages.ts";
import { MigrateError, formatMigrate, formatMigrateError, runMigrate } from "./migrate.ts";
import { runNextCommand } from "./next.ts";
import { runSkillsCommand } from "./skills.ts";
import { runValidateCommand } from "./validate.ts";

/** A message to show, and an optional error notice. */
export type Reply = { customType: string; content: string; error?: string };

const NOT_INITIALIZED = "livespec is not set up in this project: run /livespec init first.";
const INIT_RELOAD_HINT = "Run /reload to start livespec in this session.";

export async function validateReply(ctx: ExtensionCommandContext): Promise<Reply> {
	const { message, exitCode } = await runValidateCommand(ctx.cwd);
	const reply: Reply = { customType: "livespec-validate", content: message };
	return exitCode === 1 ? { ...reply, error: "livespec validate found errors" } : reply;
}

export async function migrateReply(ctx: ExtensionCommandContext): Promise<Reply> {
	const customType = "livespec-migrate";
	try {
		const result = await runMigrate(ctx.cwd);
		const reply: Reply = { customType, content: formatMigrate(result) };
		return result.conflicts.length > 0 ? { ...reply, error: "livespec migrate-openspec refused: conflicts found" } : reply;
	} catch (error) {
		if (error instanceof MigrateError) {
			return { customType, content: formatMigrateError(error), error: "livespec migrate-openspec failed midway; see the recovery hint" };
		}
		return { customType, content: `migrate-openspec failed: ${messageOf(error)}`, error: "livespec migrate-openspec failed" };
	}
}

export function formatInit(report: InitReport): string {
	const list = (title: string, items: string[]) => (items.length === 0 ? [] : [`${title}:`, ...items.map((i) => `- ${i}`)]);
	return [
		...list("Created", report.created),
		...list("Kept", report.kept),
		...list("Failed", report.failed.map((f) => `${f.path}: ${f.reason}`)),
		INIT_RELOAD_HINT,
	].join("\n");
}

export async function initReply(ctx: ExtensionCommandContext, env: CommandEnv): Promise<Reply> {
	const report = await runInit(ctx.cwd, initDeps(ctx.cwd, env));
	const reply: Reply = { customType: "livespec-init", content: formatInit(report) };
	return report.failed.length > 0 ? { ...reply, error: "livespec init could not create everything; see the report" } : reply;
}

export async function doctorReply(ctx: ExtensionCommandContext, env: CommandEnv): Promise<Reply> {
	const results = await runDoctor(await doctorDeps(ctx, env));
	const reply: Reply = { customType: "livespec-doctor", content: formatDoctor(results) };
	return results.some((r) => r.status === "error") ? { ...reply, error: "livespec doctor found errors" } : reply;
}

/** `next` reads the running session; without an initialized one it says how to set livespec up. */
export async function nextReply(ctx: ExtensionCommandContext): Promise<Reply> {
	const session = sessionFor(ctx.cwd);
	if (!session?.initialized) return { customType: "livespec-next", content: NOT_INITIALIZED };
	return { customType: "livespec-next", content: await runNextCommand(session) };
}

export async function skillsReply(args: string, ctx: ExtensionCommandContext, env: CommandEnv): Promise<Reply> {
	return { customType: "livespec-skills", content: await runSkillsCommand(args, await skillsDeps(ctx.cwd, env)) };
}

/** `account [name]` reads and switches the running session; without one it explains why. */
export async function accountReply(args: string, ctx: ExtensionCommandContext): Promise<Reply> {
	return { customType: "livespec-account", content: await runAccountCommand(args, sessionFor(ctx.cwd)) };
}

const AUDIT_USAGE = "Usage: /livespec audit [#T], where T is an initiative issue number.";
const AUDIT_TARGET = /^#?(\d+)$/;

/** The optional `#T`: `undefined` for none, `null` for an argument that is not an issue number. */
function auditTarget(args: string): number | undefined | null {
	if (args === "") return undefined;
	const m = AUDIT_TARGET.exec(args);
	return m ? Number(m[1]) : null;
}

/** The audit's deps from the running session, with the suggestions stored in `audit.json`. */
async function auditDeps(session: Session, events: EventsLike): Promise<AuditDeps> {
	const executor = findExecutor();
	const project = session.config.project;
	const severity = session.pack.ok ? session.pack.pack.decisions["drift-severity"] : undefined;
	return {
		git: session.git,
		integration: project === null ? undefined : await integrationBranch(project, session.git),
		...(session.forge === undefined ? {} : { forge: session.forge }), writable: forgeWritable(session),
		state: await readAuditState(session.git),
		confirm: { ...(executor.ok ? { service: executor.service } : {}), events, git: session.git, root: session.cwd, exclusions: await exclusionsOf(session, defaultSubagentDeps) },
		...(severity === undefined ? {} : { severity }),
	};
}

/** `audit [#T]` audits the integration branch of the running session; without an initialized one it says how to set livespec up. */
export async function auditReply(args: string, ctx: ExtensionCommandContext, events: EventsLike): Promise<Reply> {
	const customType = "livespec-audit";
	const session = sessionFor(ctx.cwd);
	if (!session?.initialized) return { customType, content: NOT_INITIALIZED };
	const target = auditTarget(args);
	if (target === null) return { customType, content: AUDIT_USAGE, error: "livespec audit: the target must be an issue number" };
	const out = await runAudit(await auditDeps(session, events), target);
	if (!out.ok) return { customType, content: out.text, error: "livespec audit refused" };
	return { customType, content: out.text, ...(await recordAudit(session, out)) };
}

/**
 * Stores what the audit covered and updates the card's Audit section only (the audit's one forge write is its
 * `drift-report`); a failed write keeps the report and says so.
 */
async function recordAudit(session: Session, out: Extract<AuditOutcome, { ok: true }>): Promise<{ error?: string }> {
	try {
		session.showAudit(await auditAndSave(session.git, out));
	} catch (error) {
		return { error: `livespec audit: the audit state was not saved: ${session.record("audit", error)}` };
	}
	return {};
}
