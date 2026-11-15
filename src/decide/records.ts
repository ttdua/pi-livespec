// Decision records: the `decision` marked comment, the latest record per id,
// and the small-fix pull request body block.

import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { type MarkedComment, writeMarked } from "../forge/markers.ts";

export type DecisionRecord = {
	point: string;
	subject: string;
	digest?: string;
	source: "rule" | "human";
	outcome: unknown;
	facts?: unknown;
	facts_hash?: string;
	reason: string;
	agent_additions?: string[];
	overridden_by?: { by: string; at: string; from: unknown };
	request?: string;
};

const MAX_FACTS_YAML = 2000;
const BLOCK_MARKER = /^<!-- livespec:decision:([A-Za-z0-9._-]+) -->$/;
const FENCE_OPEN = "```yaml";
const FENCE_CLOSE = /^```\s*$/;

function isRecord(v: unknown): v is DecisionRecord {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const r = v as Record<string, unknown>;
	return typeof r.point === "string" && typeof r.subject === "string" && (r.source === "rule" || r.source === "human") && typeof r.reason === "string";
}

/** Replaces `facts` with `facts_hash` (sha256 hex of its yaml) when that yaml exceeds 2,000 characters. */
function compactFacts(r: DecisionRecord): DecisionRecord {
	if (r.facts === undefined) return r;
	const yaml = stringify(r.facts);
	if (yaml.length <= MAX_FACTS_YAML) return r;
	const { facts: _facts, ...rest } = r;
	return { ...rest, facts_hash: createHash("sha256").update(yaml).digest("hex") };
}

/** The `decision` marked comment body, id `<point>.<subject>`. */
export function decisionComment(r: DecisionRecord): string {
	return writeMarked("decision", `${r.point}.${r.subject}`, compactFacts(r));
}

/** The latest valid `decision` record per id, keyed in first-seen order. */
export function latestDecisions(marked: MarkedComment[]): Map<string, DecisionRecord> {
	const latest = new Map<string, DecisionRecord>();
	for (const m of marked) {
		if (m.kind === "decision" && isRecord(m.data)) latest.set(m.id, m.data);
	}
	return latest;
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
