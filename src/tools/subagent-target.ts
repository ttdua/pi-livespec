// Parameters of the subagent tools: role, unit and subject, their checks, and the refusals shared by every tool.

import type { ChangeState } from "../engine/state-types.ts";
import { type ChildCheckContext, isChildSession } from "../subagents/child.ts";
import { AGENT_OF, ROLE_SUBJECTS, type ReviewSubject, type Role } from "../subagents/roles.ts";
import { type ToolResult, toolResult } from "./guard.ts";

export type TargetParams = { role: string; unit?: string; subject?: string; finding?: string };
export type Target = { role: Role; unit?: string; subject?: ReviewSubject; finding?: string };

export const CHILD_REFUSAL = (tool: string): string => `${tool} refused: only the main session dispatches and records subagent runs; this is a child session. Nothing was launched or written.`;

/** What a tool reads from pi's tool context: the session check and the UI notifier. */
export type ToolCtx = ChildCheckContext & { ui?: { notify?(message: string, type?: "info" | "warning" | "error"): void } };

/** Refuses in a child session before anything else runs. */
export const childRefusal = (tool: string, ctx: ToolCtx): ToolResult<undefined> | undefined => (isChildSession(ctx) ? toolResult(CHILD_REFUSAL(tool), undefined, true) : undefined);

export const warn = (ctx: ToolCtx) => (text: string): void => ctx.ui?.notify?.(text, "warning");

export const refusal = (tool: string, message: string): ToolResult<undefined> => toolResult(`${tool} refused: ${message} Nothing was launched or written.`, undefined, true);

const isRole = (r: string): r is Role => Object.hasOwn(AGENT_OF, r);

/** A fixed subject or `persona:<name>`; own values only, so prototype keys never pass. */
const isSubject = (s: string): s is ReviewSubject => ROLE_SUBJECTS.some((x) => x === s) || (s.startsWith("persona:") && s.length > "persona:".length);

const FINDING_REF = /^[^\s:]+:\d+$/;

type FindingRef = { ok: true; finding?: string } | { ok: false; message: string };

/** The finding reference of a verifier call, or why the reference cannot be used. */
function checkFindingRef(role: Role, finding: unknown): FindingRef {
	if (role !== "verifier") return { ok: true };
	if (finding === undefined) return { ok: false, message: "a finding reference <aggregateCommentId>:<index> is required for a verifier." };
	if (typeof finding !== "string" || !FINDING_REF.test(finding)) return { ok: false, message: `finding reference ${JSON.stringify(finding)} must look like <aggregateCommentId>:<index>.` };
	return { ok: true, finding };
}

/** The role, subject and unit, or why they cannot name a run; the unit must exist in the change. */
export function checkTarget(p: TargetParams, state: ChangeState): Target | string {
	if (typeof p.role !== "string" || !isRole(p.role)) return `unknown role ${JSON.stringify(p.role)}; use one of ${Object.keys(AGENT_OF).join(", ")}.`;
	const role = p.role;
	if (p.subject !== undefined && (typeof p.subject !== "string" || !isSubject(p.subject))) return `unknown subject ${JSON.stringify(p.subject)}; use one of ${ROLE_SUBJECTS.join(", ")} or persona:<name>.`;
	if (role === "reviewer" && p.subject === undefined) return "a reviewer needs a subject (spec, plan, unit, change or persona:<name>).";
	const needsUnit = role === "implementer" || p.subject === "unit";
	if (needsUnit && p.unit === undefined) return `a unit id is required for ${[role, p.subject].filter(Boolean).join(" ")}.`;
	if (p.unit !== undefined && !state.change.units.some((u) => u.id === p.unit)) return `unit ${p.unit} does not exist in the change.`;
	const ref = checkFindingRef(role, p.finding);
	if (!ref.ok) return ref.message;
	return { role, ...(ref.finding === undefined ? {} : { finding: ref.finding }), ...(p.unit === undefined ? {} : { unit: p.unit }), ...(p.subject === undefined ? {} : { subject: p.subject as ReviewSubject }) };
}

export const argsOf = (t: Target): string => [t.role, t.unit, t.subject, t.finding].filter((p) => p !== undefined).join(" ");

/** Parameters shared by `subagent_dispatch`, `subagent_packet` and `subagent_record`. */
export const TARGET_PROPERTIES = {
	role: { type: "string", enum: Object.keys(AGENT_OF) },
	unit: { type: "string", description: "Unit id such as U3. Required for implementer and for reviewer subject unit; optional for scout and other reviewer subjects; omit for verifier." },
	subject: { type: "string", description: "Only for role reviewer: spec, plan, unit, change or persona:<name>. Omit for other roles (ignored with a warning)." },
	finding: { type: "string", description: "Only for role verifier (required): <aggregateCommentId>:<index>. Omit for other roles (ignored with a warning)." },
};

/** Parameters by role, appended to the description of each subagent tool. */
export const PARAMS_BY_ROLE = "Parameters by role: scout [unit]; implementer unit; reviewer subject [+ unit when subject is unit]; verifier finding. Omit the others.";

/**
 * Treats `""` as omitted and, for a known role, drops a `subject` unless the role is reviewer and a `finding` unless it
 * is verifier, with one warning each. The dropped values are not validated.
 */
export function ignoreInapplicable<P extends TargetParams>(p: P): { params: P; warnings: string[] } {
	const params: P = { ...p };
	for (const key of ["unit", "subject", "finding"] as const) if (params[key] === "") delete params[key];
	const warnings: string[] = [];
	if (!isRole(String(p.role))) return { params, warnings };
	if (params.subject !== undefined && p.role !== "reviewer") {
		warnings.push(`Warning: ignored subject ${JSON.stringify(params.subject)}: only reviewer takes a subject.`);
		delete params.subject;
	}
	if (params.finding !== undefined && p.role !== "verifier") {
		warnings.push(`Warning: ignored finding ${JSON.stringify(params.finding)}: only verifier takes a finding reference.`);
		delete params.finding;
	}
	return { params, warnings };
}

/** The result with the warnings on top of its text; unchanged when there are none. */
export function withWarnings<D>(warnings: string[], result: ToolResult<D>): ToolResult<D> {
	if (warnings.length === 0) return result;
	const [first, ...rest] = result.content;
	return { ...result, content: [{ type: "text", text: `${warnings.join("\n")}\n\n${first?.text ?? ""}` }, ...rest] };
}
