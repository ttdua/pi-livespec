// Classification of planned units (design D9 step 2, D9a): the `tags` and then
// the `difficulty` decision per unit. A rule may ask a human through the approver;
// a pending answer stops classification. Records exist only for rule decisions
// (human ones are already on the issue), keyed by the rendered unit's digest.
// Nothing is posted here; the caller posts the records once the plan is valid.

import { parseChange, type Unit } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import { type RenderableUnit, renderUnit, type UnitInput } from "../core/unit-blocks.ts";
import { type Decided, decide } from "../decide/seam.ts";
import type { DecisionAsker } from "./decide-ask.ts";
import type { DecisionRecord } from "../decide/records.ts";
import type { Pack } from "../engine/pack-types.ts";

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const labelled = <K extends string>(v: unknown, key: K): ({ label: string } & Record<K, string>)[] =>
	(Array.isArray(v) ? v : []).map((x) => {
		const o = (typeof x === "object" && x !== null ? x : {}) as Record<string, unknown>;
		return { label: text(o.label), [key]: text(o[key]) } as { label: string } & Record<K, string>;
	});

/**
 * A tool's unit parameter as a well-typed `UnitInput`: a missing field becomes empty, so the LS-02 unit
 * validators report it (e.g. a unit without `verify` fails `units-format`) instead of rendering `undefined`.
 */
export function normalizeUnitInput(raw: unknown): UnitInput {
	const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const unit: UnitInput = {
		title: text(o.title),
		covers: strings(o.covers),
		files: strings(o.files),
		done_means: labelled(o.done_means, "text"),
		scenarios: labelled(o.scenarios, "ref"),
		depends: strings(o.depends),
		verify: text(o.verify),
	};
	if (o.kind === "refactor") unit.kind = "refactor";
	if (o.extra_tags !== undefined) unit.extra_tags = strings(o.extra_tags);
	return unit;
}

export type ClassifiedUnits = { units: RenderableUnit[]; records: DecisionRecord[] };
export type Pending = { status: "pending"; point: string; subject: string; requestId: string };
export type ClassifyResult = ({ status: "classified" } & ClassifiedUnits) | Pending;

/** The unit as the body would parse it, for its digest; Difficulty and Tags do not affect the digest. */
function parsedUnit(u: RenderableUnit): Unit {
	const unit = parseChange(`## Units\n${renderUnit(u).join("\n")}\n`).units[0];
	if (!unit) throw new Error(`unit ${u.id} does not render as a unit block`);
	return unit;
}

type Settled = { status: "decided"; decided: Decided } | Pending;

/** Runs one decision point for a unit; a pending ask comes back as `Pending`. */
async function settle(point: string, facts: unknown, config: unknown, id: string, digest: string, ask?: DecisionAsker): Promise<Settled> {
	const result = await decide(point, facts, { config, subject: id, digest, ...(ask ? { ask } : {}) });
	if (result.status === "pending") return { status: "pending", point, subject: id, requestId: result.requestId };
	return { status: "decided", decided: result };
}

/** A human `tags` answer must be a list of tags; a rule's is by construction. */
function tagList(id: string, outcome: unknown): string[] {
	if (!Array.isArray(outcome) || !outcome.every((t) => typeof t === "string")) throw new Error(`decision \`tags.${id}\` answer is not a list of tags`);
	return outcome;
}

function record(point: string, subject: string, digest: string, d: Decided): DecisionRecord {
	const r: DecisionRecord = { point, subject, digest, source: d.source, outcome: d.outcome, facts: d.facts, reason: d.reason };
	const additions = d.data?.agentAdditions ?? [];
	if (additions.length > 0) r.agent_additions = additions;
	return r;
}

/** Only rule decisions are recorded here; a human answer is already a record on the issue. */
const ruleRecords = (id: string, digest: string, decided: [string, Decided][]): DecisionRecord[] =>
	decided.filter(([, d]) => d.source === "rule").map(([point, d]) => record(point, id, digest, d));

async function classifyOne(id: string, input: UnitInput, config: Pack["decisions"], ask?: DecisionAsker): Promise<ClassifyResult> {
	const digest = unitDigest(parsedUnit({ ...input, id, difficulty: "low", tags: [] }));
	const tagFacts = { title: input.title, covers: input.covers, files: input.files, doneMeans: input.done_means.map((d) => d.text), extraTags: input.extra_tags ?? [] };
	const tags = await settle("tags", tagFacts, config.tags, id, digest, ask);
	if (tags.status === "pending") return tags;
	const tagNames = tagList(id, tags.decided.outcome);
	const difficulty = await settle("difficulty", { tags: tagNames, covers: input.covers, files: input.files }, config.difficulty, id, digest, ask);
	if (difficulty.status === "pending") return difficulty;
	const unit: RenderableUnit = { ...input, id, difficulty: String(difficulty.decided.outcome), tags: tagNames };
	return { status: "classified", units: [unit], records: ruleRecords(id, digest, [["tags", tags.decided], ["difficulty", difficulty.decided]]) };
}

/** Classifies each unit under the id its caller allocated; stops at the first pending ask. Records come in unit order, `tags` before `difficulty`. */
export async function classifyUnits(units: { id: string; input: UnitInput }[], config: Pack["decisions"], ask?: DecisionAsker): Promise<ClassifyResult> {
	const out: ClassifiedUnits = { units: [], records: [] };
	for (const { id, input } of units) {
		const one = await classifyOne(id, input, config, ask);
		if (one.status === "pending") return one;
		out.units.push(...one.units);
		out.records.push(...one.records);
	}
	return { status: "classified", ...out };
}
