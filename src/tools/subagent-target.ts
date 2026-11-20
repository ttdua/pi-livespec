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

/** The finding reference of a verifier call; a message object names why the reference cannot be used. */
function checkFindingRef(role: Role, finding: unknown): string | undefined | { message: string } {
	if (role !== "verifier") return finding === undefined ? undefined : { message: `only a verifier takes a finding reference; ${role} does not.` };
	if (finding === undefined || finding === "") return { message: "a finding reference <aggregateCommentId>:<index> is required for a verifier." };
	if (typeof finding !== "string" || !FINDING_REF.test(finding)) return { message: `finding reference ${JSON.stringify(finding)} must look like <aggregateCommentId>:<index>.` };
	return finding;
}

/** The role, subject and unit, or why they cannot name a run; the unit must exist in the change. */
export function checkTarget(p: TargetParams, state: ChangeState): Target | string {
	if (typeof p.role !== "string" || !isRole(p.role)) return `unknown role ${JSON.stringify(p.role)}; use one of ${Object.keys(AGENT_OF).join(", ")}.`;
	const role = p.role;
	if (p.subject !== undefined && (typeof p.subject !== "string" || !isSubject(p.subject))) return `unknown subject ${JSON.stringify(p.subject)}; use one of ${ROLE_SUBJECTS.join(", ")} or persona:<name>.`;
	if (p.subject !== undefined && role !== "reviewer") return `only a reviewer takes a subject; ${role} does not.`;
	if (role === "reviewer" && p.subject === undefined) return "a reviewer needs a subject (spec, plan, unit, change or persona:<name>).";
	const needsUnit = role === "implementer" || p.subject === "unit";
	if (needsUnit && (p.unit === undefined || p.unit === "")) return `a unit id is required for ${[role, p.subject].filter(Boolean).join(" ")}.`;
	if (p.unit !== undefined && !state.change.units.some((u) => u.id === p.unit)) return `unit ${p.unit} does not exist in the change.`;
	const finding = checkFindingRef(role, p.finding);
	if (typeof finding === "object") return finding.message;
	return { role, ...(finding === undefined ? {} : { finding }), ...(p.unit === undefined ? {} : { unit: p.unit }), ...(p.subject === undefined ? {} : { subject: p.subject as ReviewSubject }) };
}

export const argsOf = (t: Target): string => [t.role, t.unit, t.subject, t.finding].filter((p) => p !== undefined).join(" ");

/** Parameters shared by `subagent_dispatch`, `subagent_packet` and `subagent_record`. */
export const TARGET_PROPERTIES = {
	role: { type: "string", enum: Object.keys(AGENT_OF) },
	unit: { type: "string", description: "Unit id such as U3; required for implementer and for reviewer with subject unit, optional otherwise" },
	subject: { type: "string", description: "Reviewer only: spec, plan, unit, change or persona:<name>" },
	finding: { type: "string", description: "Verifier only (required): <aggregateCommentId>:<index>, the aggregate finding to verify" },
};
