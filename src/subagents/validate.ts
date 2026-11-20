// Shape validators for own `dispatch`, `finding-summary` and `lane` marker data; enum values come from the role schemas.

import { AGENT_OF, FINDING_SCHEMA, resultSchema, ROLE_SUBJECTS } from "./roles.ts";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const optional = (v: unknown, ok: (x: unknown) => boolean): boolean => v === undefined || ok(v);

const ROLES: readonly string[] = Object.keys(AGENT_OF);
const RESULT_STATUSES: readonly string[] = resultSchema("scout").properties?.status?.enum ?? [];
const FINDING_KEYS = ["severity", "kind", "location", "evidence", "fix", "scope"] as const;

const oneOf = (list: readonly string[]) => (v: unknown): boolean => isStr(v) && list.includes(v);
const isRole = oneOf(ROLES);
/** The `outcome` values of a closed `lane` record. */
export const LANE_OUTCOME_NAMES = ["merged", "violation", "conflict", "red", "moved"] as const;
const isStatus = oneOf(RESULT_STATUSES);
const isThinking = oneOf(["low", "medium", "high"]);

/** A `ReviewSubject`: a fixed subject or `persona:<name>` with a non-empty name. */
const isSubject = (v: unknown): boolean => isStr(v) && (ROLE_SUBJECTS.includes(v as never) || (v.startsWith("persona:") && v.length > "persona:".length));

export function isFindingData(v: unknown): boolean {
	if (!isObj(v) || !FINDING_KEYS.every((k) => isStr(v[k]))) return false;
	const enums = FINDING_SCHEMA.properties ?? {};
	return (["severity", "kind", "scope"] as const).every((k) => oneOf(enums[k]?.enum ?? [])(v[k]));
}

const isRequested = (v: unknown): boolean => isObj(v) && isThinking(v.thinking);
const isEffective = (v: unknown): boolean => isObj(v) && optional(v.model, isStr) && optional(v.thinking, isStr);

/** Fields every dispatch variant may carry; each is type-checked when present. */
const hasCommonFields = (d: Obj): boolean => isRole(d.role) && optional(d.unit, isStr) && optional(d.subject, isSubject) && optional(d.agentId, isStr) && optional(d.attempt, isNum);

/** A settled run: every field `DispatchData` requires. */
function isResultDispatch(d: Obj): boolean {
	return (
		isStatus(d.status) && isNum(d.attempt) && isStr(d.packet) && isStr(d.agentSource) && isRequested(d.requested) && isEffective(d.effective) &&
		isStrList(d.commits) && isStr(d.notes) && isStrList(d.discoveries) && isStrList(d.sources_used) && optional(d.reason, isStr) && optional(d.evidence, isStr) &&
		optional(d.launchMismatch, (v) => v === true) && optional(d.contextRequest, isNum)
	);
}

export function isDispatchData(d: unknown): boolean {
	if (!isObj(d) || !hasCommonFields(d)) return false;
	if (d.status === "QUESTION") return isStr(d.agentId) && isStr(d.question);
	if (d.status === "ANSWERED") return isStr(d.agentId) && isStr(d.answer);
	return isResultDispatch(d);
}

function isRebuttal(d: Obj): boolean {
	return isStr(d.rebuts) && Array.isArray(d.items) && d.items.every((i) => isObj(i) && isNum(i.index) && isStr(i.reason) && isStr(i.evidence));
}

export function isSummaryData(d: unknown): boolean {
	if (!isObj(d)) return false;
	if (d.rebuts !== undefined) return isRebuttal(d);
	return (
		isRole(d.role) && isSubject(d.subject) && isStatus(d.status) && isNum(d.round) && isStr(d.head) &&
		typeof d.advisory === "boolean" && typeof d.completed === "boolean" &&
		isStrList(d.sources_used) && isStrList(d.required) && optional(d.unit, isStr) && optional(d.agentId, isStr) &&
		isStr(d.packet) && isStr(d.agentSource) && isRequested(d.requested) && isEffective(d.effective) &&
		Array.isArray(d.findings) && d.findings.every(isFindingData) && optional(d.contextRequest, isNum)
	);
}

export function isLaneData(d: unknown): boolean {
	return (
		isObj(d) && ["unit", "path", "branch", "base"].every((k) => isStr(d[k])) && optional(d.closed, (c) => c === true) &&
		optional(d.outcome, oneOf(LANE_OUTCOME_NAMES)) && optional(d.head, isStr)
	);
}
