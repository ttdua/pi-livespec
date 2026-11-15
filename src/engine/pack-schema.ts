import {
	type Document,
	type LineCounter,
	type Node,
	type Pair,
	isMap,
	isScalar,
	isSeq,
	type YAMLMap,
	type YAMLSeq,
} from "yaml";
import type { PackError } from "./pack-types.ts";
import { checkNames, getPackSchema } from "./registry.ts";

const TOP_KEYS = ["name", "version", "content", "limits", "loops", "decisions", "init", "phases", "extends"];
const PHASE_KEYS = ["id", "requires", "per", "skills", "outputs", "redirects", "checks", "gate", "subagents"];
const MODEL_KEYS = ["model", "models", "lanes", "lane_count"];
const GATES = ["none", "self", "human"];
const OUTPUTS = ["issue#Capabilities", "issue#Proposal", "issue#Design", "issue#Units", "specs-diff"];
const EXCLUDED = ["using-agent-skills", "context-engineering"];
const KNOWN_PACKS = ["agent-skills"];
const MODEL_MESSAGE = "packs never name models or lane counts (ADR 0005)";

type Mode = "pack" | "override";

class Reporter {
	readonly errors: PackError[] = [];
	constructor(
		readonly file: string,
		readonly lc: LineCounter,
	) {}

	at(node: Node | null | undefined, path: string, message: string, severity: "error" | "warning" = "error"): void {
		const offset = node?.range?.[0] ?? 0;
		const { line, col } = this.lc.linePos(offset);
		this.errors.push({ severity, file: this.file, line, col, path, message });
	}
}

function keyName(pair: Pair): string | undefined {
	return isScalar(pair.key) ? String(pair.key.value) : undefined;
}

/** Keys of a map checked against an allowed list; model keys get their own message. */
function checkKeys(r: Reporter, map: YAMLMap, allowed: string[], path: string): void {
	for (const pair of map.items) {
		const key = keyName(pair);
		if (key === undefined) r.at(pair.key as Node, path, "keys must be plain strings");
		else if (MODEL_KEYS.includes(key)) r.at(pair.key as Node, `${path}.${key}`, `\`${key}\`: ${MODEL_MESSAGE}`);
		else if (!allowed.includes(key)) {
			r.at(pair.key as Node, `${path}.${key}`, `unknown key \`${key}\`; allowed: ${allowed.join(", ")}`);
		}
	}
}

function getPair(map: YAMLMap, key: string): Pair | undefined {
	return map.items.find((p) => keyName(p) === key);
}

function stringList(r: Reporter, node: Node | null, path: string): { node: Node; value: string }[] | undefined {
	if (!isSeq(node)) {
		r.at(node, path, `\`${path}\` must be a list`);
		return undefined;
	}
	const items: { node: Node; value: string }[] = [];
	for (const item of (node as YAMLSeq).items) {
		if (isScalar(item) && typeof item.value === "string") items.push({ node: item, value: item.value });
		else r.at(item as Node, path, `\`${path}\` entries must be strings`);
	}
	return items;
}

function enumValue(r: Reporter, node: Node | null, path: string, allowed: string[]): void {
	if (!isScalar(node) || typeof node.value !== "string" || !allowed.includes(node.value)) {
		r.at(node, path, `\`${path}\` must be one of: ${allowed.join(", ")}`);
	}
}

function validateNumberMap(r: Reporter, node: Node | null, path: string): void {
	if (!isMap(node)) {
		r.at(node, path, `\`${path}\` must be a map`);
		return;
	}
	for (const pair of node.items) {
		if (!isScalar(pair.value) || typeof pair.value.value !== "number") {
			r.at(pair.value as Node, `${path}.${keyName(pair)}`, `\`${keyName(pair)}\` must be a number`);
		}
	}
}

function validateRegistered(r: Reporter, key: "decisions" | "subagents", node: Node | null, path: string): void {
	const schema = getPackSchema(key);
	if (schema) {
		schema.validate(node, (n, message) => r.at(n, path, message));
		return;
	}
	const empty = key === "decisions" ? isMap(node) && node.items.length === 0 : isSeq(node) && node.items.length === 0;
	if (empty) return;
	r.at(node, path, `\`${key}\` must be empty: no spec has registered \`${key}\``);
}

function validateInit(r: Reporter, node: Node | null): void {
	if (!isMap(node)) return r.at(node, "init", "`init` must be a map");
	checkKeys(r, node, ["skills"], "init");
	const skills = getPair(node, "skills");
	if (skills) stringList(r, skills.value as Node | null, "init.skills");
}

function validateSkills(r: Reporter, node: Node | null, path: string): void {
	if (!isMap(node)) return r.at(node, path, `\`${path}\` must be a map`);
	checkKeys(r, node, ["required", "optional"], path);
	for (const key of ["required", "optional"]) {
		const pair = getPair(node, key);
		if (!pair) continue;
		const items = stringList(r, pair.value as Node | null, `${path}.${key}`);
		for (const item of items ?? []) {
			if (EXCLUDED.includes(item.value)) {
				r.at(item.node, `${path}.${key}`, `\`${item.value}\` is never exposed`, "warning");
			}
		}
	}
}

function validateCheckNames(r: Reporter, node: Node | null, path: string): void {
	const known = checkNames();
	for (const item of stringList(r, node, path) ?? []) {
		if (!known.includes(item.value)) {
			r.at(item.node, path, `unknown check \`${item.value}\`; registered: ${known.join(", ") || "(none)"}`);
		}
	}
}

function validateOutputs(r: Reporter, node: Node | null, path: string): void {
	for (const item of stringList(r, node, path) ?? []) {
		if (!OUTPUTS.includes(item.value)) r.at(item.node, path, `unknown output \`${item.value}\`; allowed: ${OUTPUTS.join(", ")}`);
	}
}

const PHASE_VALIDATORS = new Map<string, (r: Reporter, node: Node | null, path: string) => void>(Object.entries({
	id: (r, node, path) => {
		if (!isScalar(node) || typeof node.value !== "string" || node.value === "") r.at(node, path, "`id` must be a non-empty string");
	},
	requires: (r, node, path) => void stringList(r, node, path),
	per: (r, node, path) => enumValue(r, node, path, ["unit"]),
	skills: validateSkills,
	outputs: validateOutputs,
	redirects: (r, node, path) => void stringList(r, node, path),
	checks: validateCheckNames,
	gate: (r, node, path) => enumValue(r, node, path, GATES),
	subagents: (r, node, path) => validateRegistered(r, "subagents", node, path),
}));

function validatePhase(r: Reporter, node: Node | null, index: number): void {
	const path = `phases[${index}]`;
	if (!isMap(node)) return r.at(node, path, "a phase must be a map");
	checkKeys(r, node, PHASE_KEYS, path);
	for (const pair of node.items) {
		const key = keyName(pair);
		if (key) PHASE_VALIDATORS.get(key)?.(r, pair.value as Node | null, `${path}.${key}`);
	}
	if (!getPair(node, "id")) r.at(node, path, "a phase needs an `id`");
}

function validatePhases(r: Reporter, node: Node | null): void {
	if (!isSeq(node)) return r.at(node, "phases", "`phases` must be a list");
	const seen = new Set<string>();
	node.items.forEach((item, i) => {
		validatePhase(r, item as Node | null, i);
		const idPair = isMap(item) ? getPair(item, "id") : undefined;
		const id = isScalar(idPair?.value) ? idPair.value.value : undefined;
		if (typeof id !== "string") return;
		if (seen.has(id)) r.at(idPair?.value as Node, `phases[${i}].id`, `duplicate phase id \`${id}\``);
		seen.add(id);
	});
}

const TOP_VALIDATORS = new Map<string, (r: Reporter, node: Node | null) => void>(Object.entries({
	name: (r, n) => stringScalar(r, n, "name"),
	content: (r, n) => stringScalar(r, n, "content"),
	version: (r, n) => {
		if (!isScalar(n) || n.value !== 1) r.at(n, "version", "`version` must be 1");
	},
	limits: (r, n) => validateNumberMap(r, n, "limits"),
	loops: (r, n) => validateNumberMap(r, n, "loops"),
	decisions: (r, n) => validateRegistered(r, "decisions", n, "decisions"),
	init: validateInit,
	phases: validatePhases,
	extends: (r, n) => {
		if (!isScalar(n) || typeof n.value !== "string" || !KNOWN_PACKS.includes(n.value)) {
			r.at(n, "extends", `unknown pack \`${isScalar(n) ? String(n.value) : "?"}\`; known: ${KNOWN_PACKS.join(", ")}`);
		}
	},
}));

function stringScalar(r: Reporter, node: Node | null, path: string): void {
	if (!isScalar(node) || typeof node.value !== "string" || node.value === "") r.at(node, path, `\`${path}\` must be a non-empty string`);
}

function validateTopLevel(r: Reporter, map: YAMLMap, mode: Mode): void {
	checkKeys(r, map, TOP_KEYS, "");
	const extending = mode === "override" && getPair(map, "extends") !== undefined;
	for (const pair of map.items) {
		const key = keyName(pair);
		if (key) TOP_VALIDATORS.get(key)?.(r, pair.value as Node | null);
		if (extending && key && ["name", "version", "content"].includes(key)) {
			r.at(pair.key as Node, key, `an override with \`extends\` must not change \`${key}\``);
		}
	}
	if (extending) return;
	for (const required of ["name", "version", "content", "phases"]) {
		if (!getPair(map, required)) r.at(map, required, `missing required key \`${required}\``);
	}
}

export function validatePackDocument(doc: Document, file: string, lc: LineCounter, mode: Mode): PackError[] {
	const r = new Reporter(file, lc);
	if (doc.errors.length > 0) {
		return doc.errors.map((e) => {
			const pos = e.linePos?.[0] ?? { line: 1, col: 1 };
			return { severity: "error" as const, file, line: pos.line, col: pos.col, path: "", message: e.message };
		});
	}
	if (!isMap(doc.contents)) {
		r.at(doc.contents as Node | null, "", "a flow pack file must be a map");
		return r.errors;
	}
	validateTopLevel(r, doc.contents, mode);
	return r.errors;
}
