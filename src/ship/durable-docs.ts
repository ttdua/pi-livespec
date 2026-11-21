// The `durable-docs` rule (design D6): from facts built by code, the errors and confirmation items of a change's
// durable documentation, and whether the table needs rows. Pure; the registered rule never asks.

import { isMap } from "yaml";
import { matchGlob } from "../core/glob.ts";
import type { Change } from "../core/change.ts";
import type { RuleResult, RuleSchema } from "../decide/registry.ts";
import { checkAllowedKeys } from "../decide/rules/schema-util.ts";
import type { ChangeDiff } from "./diff.ts";

export type DurableFacts = {
	files: string[];
	added: string[];
	capabilities: { new: string[]; modified: string[] };
	specs: { capability: string; paths: string[] }[];
	rows: { file: string; status: string }[];
};

export type DurableOutcome = { errors: string[]; confirm: string[]; needsRows: boolean };

const SPECS = "specs/";
export const DECISIONS = "specs/decisions/";
const PRODUCT = "specs/product.md";
const CONSTRAINTS = "specs/constraints.md";

const isSpecDoc = (file: string): boolean => file.startsWith(SPECS) && !file.startsWith(DECISIONS);
const isUpdated = (rows: DurableFacts["rows"], file: string): boolean => rows.some((r) => r.file === file && r.status === "updated");

/** Files whose row must be `updated`, each with the hard requirement that says so. */
export function hardCovered(facts: DurableFacts): Map<string, string> {
	const covered = new Map<string, string>();
	if (facts.capabilities.new.length > 0) covered.set(PRODUCT, `the durable-docs rule requires it updated for a new capability [${facts.capabilities.new.join(", ")}]`);
	for (const file of facts.files) if (isSpecDoc(file)) covered.set(file, "the durable-docs rule requires it updated because the change diff changes it");
	return covered;
}

/** The facts built from the change diff, the header and the living specs read from the work tree. */
export function durableFacts(diff: ChangeDiff, change: Change, specs: DurableFacts["specs"]): DurableFacts {
	return {
		files: diff.files,
		added: diff.entries.filter((e) => e.status === "A").map((e) => e.path),
		capabilities: change.header.capabilities ?? { new: [], modified: [] },
		specs,
		rows: change.durableDocs,
	};
}

function coveredErrors(facts: DurableFacts): string[] {
	return [...hardCovered(facts)].filter(([file]) => !isUpdated(facts.rows, file)).map(([file, why]) => `${file} needs an \`updated\` row: ${why}`);
}

function rowErrors(facts: DurableFacts): string[] {
	return facts.rows.filter((r) => r.status === "updated" && !facts.files.includes(r.file)).map((r) => `${r.file} is marked updated but the change diff does not touch it`);
}

function constraintsOutcome(facts: DurableFacts): { error?: string; confirm?: string } {
	if (!facts.files.includes(CONSTRAINTS)) return {};
	const decisions = facts.added.filter((f) => f.startsWith(DECISIONS));
	if (decisions.length === 0) return { error: `${CONSTRAINTS} changed but the diff adds no decision file under ${DECISIONS}` };
	return { confirm: `constraints changed, decision ${decisions.join(", ")}: confirm ${CONSTRAINTS} and ${decisions.join(", ")}` };
}

/** Code files under a capability's `paths`, per capability; spec files never count as code. */
function capabilityCode(facts: DurableFacts): { capability: string; files: string[] }[] {
	const code = facts.files.filter((f) => !f.startsWith(SPECS));
	return facts.specs
		.map((s) => ({ capability: s.capability, files: code.filter((f) => s.paths.some((p) => matchGlob(p, f))) }))
		.filter((c) => c.files.length > 0);
}

function capabilityConfirms(facts: DurableFacts): string[] {
	return capabilityCode(facts)
		.filter((c) => !isUpdated(facts.rows, `${SPECS}${c.capability}/spec.md`))
		.map((c) => `${c.capability}: confirm its behavior did not change (changed ${c.files.join(", ")})`);
}

export function durableDocsRule(facts: DurableFacts): DurableOutcome {
	const constraints = constraintsOutcome(facts);
	const errors = [...coveredErrors(facts), ...(constraints.error === undefined ? [] : [constraints.error]), ...rowErrors(facts)];
	const confirm = [...(constraints.confirm === undefined ? [] : [constraints.confirm]), ...capabilityConfirms(facts)];
	const needsRows = facts.files.some(isSpecDoc) || facts.capabilities.new.length > 0 || capabilityCode(facts).length > 0;
	return { errors, confirm, needsRows };
}

export const durableDocsSchema: RuleSchema = {
	validate(node, report) {
		if (isMap(node)) checkAllowedKeys(node, ["mode"], "decisions.durable-docs", report);
	},
};

/** The registered rule: the outcome is the rule result, and it never asks. */
export function durableDocsRuleFn(facts: unknown): RuleResult {
	const outcome = durableDocsRule(facts as DurableFacts);
	return { outcome, reason: `${outcome.errors.length} errors, ${outcome.confirm.length} to confirm` };
}
