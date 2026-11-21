// Finding routing: where one review finding goes (design D5). Pure; no I/O.

import { isMap } from "yaml";
import { matchGlob } from "../core/glob.ts";
import type { RuleResult, RuleSchema } from "../decide/registry.ts";
import { checkAllowedKeys } from "../decide/rules/schema-util.ts";
import type { Finding } from "../subagents/roles.ts";

export type Route = "unit" | "in-change" | "out-of-scope" | "question" | "record";

export type RouteFacts = {
	path: string;
	units: { id: string; files: string[] }[];
	diffFiles: string[];
	needsDecision: boolean;
};

export type RouteResult = { route: Route; unit?: string };

/** `path`, `path:line` or `path:line:col` to a repository-relative POSIX path and a line (1 when absent). */
export function normalizeLocation(location: string): { path: string; line: number } {
	const match = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(location.trim());
	const raw = (match?.[1] ?? location).replaceAll("\\", "/");
	const path = raw.replace(/^(?:\.?\/)+/, "");
	const line = Number(match?.[2] ?? 1);
	return { path, line: line > 0 ? line : 1 };
}

const unitOwning = (path: string, units: RouteFacts["units"]): string | undefined =>
	units.find((u) => u.files.some((f) => f === path || matchGlob(f, path)))?.id;

/** Design D5 order: record, question, unit, in-change, out-of-scope. */
export function routeFinding(finding: Finding, facts: RouteFacts): RouteResult {
	if (finding.severity === "SUGGESTION" && finding.kind !== "missed-context") return { route: "record" };
	if (facts.needsDecision) return { route: "question" };
	const unit = unitOwning(facts.path, facts.units);
	if (unit !== undefined) return { route: "unit", unit };
	if (facts.diffFiles.includes(facts.path) || finding.kind === "missed-context") return { route: "in-change" };
	return { route: "out-of-scope" };
}

export const findingScopeSchema: RuleSchema = {
	validate(node, report) {
		if (isMap(node)) checkAllowedKeys(node, ["mode"], "decisions.finding-scope", report);
	},
};

export type FindingScopeFacts = RouteFacts & { finding: Finding };

const REASONS: Record<Route, string> = {
	record: "a suggestion is only recorded",
	question: "the finding needs a human decision",
	unit: "the path is in a unit's Files",
	"in-change": "the path is in the diff or the finding is missed context",
	"out-of-scope": "the path is outside every unit and the diff",
};

/** The `finding-scope` rule; never asks. */
export function findingScopeRule(facts: unknown, _config: unknown): RuleResult {
	const { finding, ...rest } = facts as FindingScopeFacts;
	const result = routeFinding(finding, rest);
	const unit = result.unit === undefined ? "" : ` ${result.unit}`;
	return { outcome: result, reason: `${result.route}${unit}: ${REASONS[result.route]}` };
}
