// Subagents pack policy: validates the per-phase `subagents` key and decides when an `auto` entry holds.
import { type Node, type Pair, isMap, isScalar, isSeq } from "yaml";
import type { Unit } from "../core/change.ts";
import { matchGlob } from "../core/glob.ts";
import type { Spec } from "../core/spec.ts";
import type { Pack } from "../engine/pack-types.ts";
import { registerPackSchema } from "../engine/registry.ts";
import { personaOf } from "./sources-persona.ts";
import { ROLE_SUBJECTS, type ReviewSubject, type Role, type SubagentEntry } from "./roles.ts";

export type PolicyFacts = {
	units: number;
	difficulty?: "low" | "medium" | "high";
	maxDifficulty?: "low" | "medium" | "high";
	tags: string[];
	unfamiliar: boolean;
	contextPercent?: number;
	turnsCompleted: number;
};

const ROLES: readonly Role[] = ["scout", "implementer", "reviewer", "verifier"];
const MODES = ["off", "always", "auto"] as const;
const ENTRY_KEYS = ["role", "subject", "mode", "when", "advisory", "skills"];
const MODEL_KEYS = ["model", "models", "lanes", "lane_count"];
const CONTEXT_MARGIN = 2;
const DIFFICULTY_RANK = { low: 0, medium: 1, high: 2 } as const;

/** Entries of `phaseId` in the pack; an unknown phase has none. */
export function entriesFor(pack: Pack, phaseId: string): SubagentEntry[] {
	const phase = pack.phases.find((p) => p.id === phaseId);
	return (phase?.subagents ?? []) as SubagentEntry[];
}

/** Persona names from `persona:<name>` subjects without the prefix, plus `code-reviewer` for a `change` subject. */
export function personas(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const found: string[] = [];
	for (const item of value) {
		const subject = typeof item === "object" && item !== null ? (item as { subject?: unknown }).subject : undefined;
		const name = typeof subject === "string" ? personaOf(subject) : undefined;
		if (name !== undefined) found.push(name);
	}
	return found;
}

/** True when the entry's `auto` conditions hold for `facts`; `off` and `always` are not decided here. */
export function holds(entry: SubagentEntry, facts: PolicyFacts): boolean {
	return (entry.when ?? []).some((condition) => conditionHolds(condition, facts));
}

function conditionHolds(condition: string, facts: PolicyFacts): boolean {
	const parsed = parseCondition(condition);
	if (!parsed) return false;
	switch (parsed.kind) {
		case "units":
			return facts.units >= parsed.n;
		case "difficulty": {
			const level = facts.maxDifficulty ?? facts.difficulty;
			return level !== undefined && DIFFICULTY_RANK[level] >= DIFFICULTY_RANK[parsed.level];
		}
		case "tags":
			return facts.tags.includes(parsed.tag);
		case "unfamiliar-code":
			return facts.unfamiliar;
		case "context":
			if (facts.turnsCompleted < 1 || facts.contextPercent === undefined) return false;
			return facts.contextPercent >= parsed.percent - CONTEXT_MARGIN;
	}
}

type Condition =
	| { kind: "units"; n: number }
	| { kind: "difficulty"; level: "low" | "medium" | "high" }
	| { kind: "tags"; tag: string }
	| { kind: "unfamiliar-code" }
	| { kind: "context"; percent: number };

function parseCondition(condition: string): Condition | undefined {
	const units = /^units>=(\d+)$/.exec(condition);
	if (units) return { kind: "units", n: Number(units[1]) };
	const difficulty = /^difficulty>=(low|medium|high)$/.exec(condition);
	if (difficulty) return { kind: "difficulty", level: difficulty[1] as "low" | "medium" | "high" };
	const tags = /^tags:(.+)$/.exec(condition);
	if (tags) return { kind: "tags", tag: tags[1] ?? "" };
	if (condition === "unfamiliar-code") return { kind: "unfamiliar-code" };
	const context = /^context>=(\d+(?:\.\d+)?)%$/.exec(condition);
	if (context) return { kind: "context", percent: Number(context[1]) };
	return undefined;
}

/**
 * The `unfamiliar-code` condition. In `build`, true when a file of `unit` matches no capability's `paths`.
 * In `shape`, `define` and `plan`, true when the repository has no specs, or a change capability (`capabilities`,
 * the names in the change's `Capabilities` header) has no spec or a spec with no `paths`.
 */
export function unfamiliarCode(phase: string, unit: Unit | undefined, specs: Spec[], capabilities: string[]): boolean {
	if (specs.length === 0) return true;
	if (phase === "build") {
		if (!unit) return false;
		const globs = specs.flatMap((s) => s.paths);
		return unit.files.some((file) => !globs.some((glob) => matchGlob(glob, file)));
	}
	return capabilities.some((capability) => {
		const spec = specs.find((s) => s.capability === capability);
		return spec === undefined || spec.paths.length === 0;
	});
}

/** Reports every error of a phase's `subagents` node; `node` is null when the key is absent. */
export function validateSubagentsNode(node: Node | null, report: (n: Node, message: string) => void): void {
	if (node === null || node === undefined) return;
	if (!isSeq(node)) return report(node, "`subagents` must be a list");
	for (const item of node.items) validateEntry(item as Node, report);
}

/** The string text of a scalar value node, or undefined for any other node. */
function scalarText(node: Node | null | undefined): string | undefined {
	return isScalar(node) && typeof node.value === "string" ? node.value : undefined;
}

function validateEntry(node: Node, report: (n: Node, message: string) => void): void {
	if (!isMap(node)) return report(node, "a subagents entry must be a map");
	const get = (key: string): Pair | undefined => node.items.find((p) => scalarText(p.key as Node) === key);
	for (const pair of node.items) {
		const key = scalarText(pair.key as Node) ?? "?";
		if (MODEL_KEYS.includes(key)) report(pair.key as Node, "packs never name models or lane counts (ADR 0005)");
		else if (!ENTRY_KEYS.includes(key)) report(pair.key as Node, `unknown key \`${key}\`; allowed: ${ENTRY_KEYS.join(", ")}`);
	}
	const roleNode = get("role")?.value as Node | undefined;
	const role = scalarText(roleNode);
	if (role === undefined || !ROLES.includes(role as Role)) {
		report(roleNode ?? node, `\`role\` must be one of: ${ROLES.join(", ")}`);
	}
	validateSubject(node, get("subject"), role, report);
	const modeNode = get("mode")?.value as Node | undefined;
	const mode = scalarText(modeNode);
	if (mode === undefined || !(MODES as readonly string[]).includes(mode)) {
		report(modeNode ?? node, `\`mode\` must be one of: ${MODES.join(", ")}`);
	}
	validateWhen(node, get("when"), mode, report);
	validateAdvisory(get("advisory"), report);
	validateSkills(get("skills"), report);
}

function validateAdvisory(pair: Pair | undefined, report: (n: Node, message: string) => void): void {
	if (!pair) return;
	const value = pair.value as Node | null;
	if (!isScalar(value) || typeof value.value !== "boolean") report(value ?? (pair.key as Node), "`advisory` must be true or false");
}

function validateSkills(pair: Pair | undefined, report: (n: Node, message: string) => void): void {
	if (!pair) return;
	const value = pair.value as Node | null;
	if (!isSeq(value)) return report(value ?? (pair.key as Node), "`skills` must be a list of skill names");
	for (const item of value.items) {
		if (scalarText(item as Node) === undefined) report(item as Node, "`skills` entries must be skill names (strings)");
	}
}

function validateSubject(node: Node, pair: Pair | undefined, role: string | undefined, report: (n: Node, message: string) => void): void {
	const subjectNode = pair?.value as Node | undefined;
	const subject = scalarText(subjectNode);
	if (pair && (subject === undefined || !isValidSubject(subject))) {
		report(subjectNode ?? node, `\`subject\` must be one of: ${ROLE_SUBJECTS.join(", ")}, or persona:<name>`);
		return;
	}
	if (role === "reviewer" && subject === undefined) report(node, "a `reviewer` entry needs a `subject`");
}

function isValidSubject(value: string): value is ReviewSubject {
	if ((ROLE_SUBJECTS as readonly string[]).includes(value)) return true;
	return value.startsWith("persona:") && value.length > "persona:".length;
}

function validateWhen(node: Node, pair: Pair | undefined, mode: unknown, report: (n: Node, message: string) => void): void {
	if (mode !== "auto" && pair) report(pair.key as Node, "`when` is only allowed with `mode: auto`");
	if (mode === "auto" && !pair) report(node, "`mode: auto` needs a `when` list");
	if (!pair) return;
	const list = pair.value as Node | null;
	if (!isSeq(list)) return report(list ?? (pair.key as Node), "`when` must be a list of conditions");
	for (const item of list.items) {
		const text = isScalar(item) ? String(item.value) : "";
		if (!parseCondition(text)) report(item as Node, `unparsable condition \`${text}\`; allowed: units>=N, difficulty>=low|medium|high, tags:<tag>, unfamiliar-code, context>=N%`);
	}
}

/** Registers the `subagents` pack sub-schema; side effect of importing this module. */
export function registerSubagentsSchema(): void {
	registerPackSchema("subagents", { validate: validateSubagentsNode, personas: (value) => personas(value) });
}

registerSubagentsSchema();
