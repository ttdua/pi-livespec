// Decision records: the `decision` marked comment, the latest record per id,
// and the small-fix pull request body block.

import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import type { Signature } from "../evidence/signature.ts";
import { type MarkedComment, writeMarked } from "../forge/markers.ts";

export type DecisionRecord = {
	point: string;
	subject: string;
	digest?: string;
	source: "rule" | "human" | "agent" | "reviewer";
	outcome: unknown;
	facts?: unknown;
	facts_hash?: string;
	reason: string;
	agent_additions?: string[];
	overridden_by?: { by: string; at: string; from: unknown };
	request?: string;
	/** A human answer given during an amendment; not effective until the amendment is approved. */
	proposal?: true;
	/** The failure signature of a `progress` record; kept when `facts` becomes `facts_hash`. */
	signature?: Signature;
	/** The attempt number of a `progress` record; kept when `facts` becomes `facts_hash`. */
	attempt?: number;
	/** The files of a `behavior-change` record; kept when `facts` becomes `facts_hash`. */
	files?: string[];
};

const MAX_FACTS_YAML = 2000;
/** The only point whose records agents and reviewers may write; other points reject those sources. */
const AGENT_SOURCE_POINT = "behavior-change";
const BLOCK_MARKER = /^<!-- livespec:decision:([A-Za-z0-9._-]+) -->$/;
const FENCE_OPEN = "```yaml";
const FENCE_CLOSE = /^```\s*$/;

const isString = (v: unknown): v is string => typeof v === "string";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: object, key: string): boolean => Object.hasOwn(o, key);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isSignature = (v: unknown): v is Signature =>
	isObject(v) && isString(v.hash) && Array.isArray(v.tests) && v.tests.every(isString);

/** Checks the optional fields' types when present. */
function optionalFieldsValid(r: Record<string, unknown>): boolean {
	if (has(r, "digest") && !isString(r.digest)) return false;
	if (has(r, "facts_hash") && !isString(r.facts_hash)) return false;
	if (has(r, "request") && !isString(r.request)) return false;
	if (has(r, "proposal") && typeof r.proposal !== "boolean") return false;
	if (has(r, "attempt") && !(typeof r.attempt === "number" && Number.isInteger(r.attempt))) return false;
	if (has(r, "signature") && !isSignature(r.signature)) return false;
	if (has(r, "files") && !isStringList(r.files)) return false;
	if (has(r, "agent_additions") && !isStringList(r.agent_additions)) return false;
	if (has(r, "overridden_by")) {
		const o = r.overridden_by;
		if (!isObject(o) || !isString(o.by) || !isString(o.at) || !has(o, "from")) return false;
	}
	return true;
}

/** `rule` and `human` for any point; `agent` and `reviewer` only for `AGENT_SOURCE_POINT`. */
function isAllowedSource(v: Record<string, unknown>): boolean {
	if (v.source === "rule" || v.source === "human") return true;
	return v.point === AGENT_SOURCE_POINT && (v.source === "agent" || v.source === "reviewer");
}

/** A decision record: required fields present (`outcome` may be any value, including falsy), optional fields well-typed. */
function isRecord(v: unknown): v is DecisionRecord {
	if (!isObject(v)) return false;
	const required = isString(v.point) && isString(v.subject) && isAllowedSource(v) && isString(v.reason) && has(v, "outcome");
	return required && optionalFieldsValid(v);
}

/**
 * Replaces `facts` with `facts_hash` (sha256 hex of its yaml) when that yaml exceeds 2,000 characters.
 * Top-level fields such as `signature`, `attempt` and `files` are kept.
 */
function compactFacts(r: DecisionRecord): DecisionRecord {
	if (r.facts === undefined) return r;
	const yaml = stringify(r.facts);
	if (yaml.length <= MAX_FACTS_YAML) return r;
	const { facts: _facts, ...rest } = r;
	return { ...rest, facts_hash: sha256Hex(yaml) };
}

/** The `decision` marked comment body, id `<point>.<subject>`. */
export function decisionComment(r: DecisionRecord): string {
	return writeMarked("decision", `${r.point}.${r.subject}`, compactFacts(r));
}

/** Every valid `decision` record with its comment id, in comment order; malformed data is skipped. */
export function validDecisionEntries(marked: MarkedComment[]): { record: DecisionRecord; commentId: string }[] {
	return marked.flatMap((m) => (m.kind === "decision" && isRecord(m.data) ? [{ record: m.data, commentId: m.commentId }] : []));
}

/** Every valid `decision` record, in comment order; malformed data is skipped. */
export function validDecisions(marked: MarkedComment[]): DecisionRecord[] {
	return validDecisionEntries(marked).map((e) => e.record);
}

/** The latest valid `decision` record per id, keyed in first-seen order. */
export function latestDecisions(marked: MarkedComment[]): Map<string, DecisionRecord> {
	const latest = new Map<string, DecisionRecord>();
	for (const m of marked) {
		if (m.kind === "decision" && isRecord(m.data)) latest.set(m.id, m.data);
	}
	return latest;
}

/** The latest `<point>.<subject>` record for `digest` that `include` accepts. */
function latestFor(marked: MarkedComment[], id: string, digest: string, include: (r: DecisionRecord) => boolean): DecisionRecord | undefined {
	let found: DecisionRecord | undefined;
	for (const m of marked) {
		if (m.kind === "decision" && m.id === id && isRecord(m.data) && m.data.digest === digest && include(m.data)) found = m.data;
	}
	return found;
}

/**
 * The latest effective `<point>.<subject>` record made for `digest` (the unit's current contract); records for
 * any other digest belong to an older contract and are skipped, even when newer. A proposal (an amendment's
 * answer before approval) is not effective and is skipped too.
 */
export function currentDecision(marked: MarkedComment[], point: string, subject: string, digest: string): DecisionRecord | undefined {
	return latestFor(marked, `${point}.${subject}`, digest, (r) => r.proposal !== true);
}

const sha256Hex = (yaml: string): string => createHash("sha256").update(yaml).digest("hex");

/** True when `record` answers `facts`: the same canonical YAML, or the same `facts_hash` when the record holds one. */
export function sameFacts(record: DecisionRecord, facts: unknown): boolean {
	const yaml = stringify(facts);
	if (record.facts_hash !== undefined) return record.facts_hash === sha256Hex(yaml);
	return record.facts !== undefined && stringify(record.facts) === yaml;
}

/**
 * The latest `<point>.<subject>` record for `digest`, proposals included (an amendment rerun reuses its own
 * answer), when it is a human answer (not dismissed) for the same facts.
 */
export function reusableAnswer(marked: MarkedComment[], point: string, subject: string, digest: string, facts: unknown): DecisionRecord | undefined {
	const record = latestFor(marked, `${point}.${subject}`, digest, () => true);
	if (record === undefined || record.source !== "human" || record.outcome === null || !sameFacts(record, facts)) return undefined;
	return record;
}

/** The small-fix PR body block: a marker line, then one fenced yaml block with the record. */
export function formatDecisionBlock(point: string, record: DecisionRecord): string {
	return `<!-- livespec:decision:${point} -->\n${FENCE_OPEN}\n${stringify(compactFacts(record))}\`\`\``;
}

/** Records from every well-formed decision block in `body`; any other text and malformed blocks are ignored. */
export function parseDecisionBlocks(body: string): DecisionRecord[] {
	const lines = body.split(/\r?\n/);
	const records: DecisionRecord[] = [];
	for (let i = 0; i < lines.length; i++) {
		const marker = BLOCK_MARKER.exec(lines[i] as string);
		if (!marker || lines[i + 1]?.trimEnd() !== FENCE_OPEN) continue;
		const end = lines.findIndex((l, j) => j > i + 1 && FENCE_CLOSE.test(l));
		if (end === -1) continue;
		const record = parseYaml(lines.slice(i + 2, end).join("\n"));
		if (isRecord(record) && record.point === marker[1]) records.push(record);
		i = end;
	}
	return records;
}

function parseYaml(text: string): unknown {
	try {
		return parse(text);
	} catch {
		return undefined;
	}
}
