// Classification of planned units (design D9 step 2, D9a): the `tags` and then
// the `difficulty` decision per unit, both pure rule runs, and one decision
// record per unit and point keyed by the rendered unit's digest. Nothing is
// posted here; the caller posts the records once the plan is valid.

import { parseChange, type Unit } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import { type RenderableUnit, renderUnit, type UnitInput } from "../core/unit-blocks.ts";
import { type Decided, decide } from "../decide/seam.ts";
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

/** The unit as the body would parse it, for its digest; Difficulty and Tags do not affect the digest. */
function parsedUnit(u: RenderableUnit): Unit {
	const unit = parseChange(`## Units\n${renderUnit(u).join("\n")}\n`).units[0];
	if (!unit) throw new Error(`unit ${u.id} does not render as a unit block`);
	return unit;
}

/** Runs a rule-only decision point; no approver is given, so a rule that asks is an error. */
async function ruleDecision(point: string, facts: unknown, config: unknown, subject: string): Promise<Decided> {
	const result = await decide(point, facts, { config, subject });
	if (result.status !== "decided") throw new Error(`decision \`${point}.${subject}\` did not decide`);
	return result;
}

function record(point: string, subject: string, digest: string, d: Decided): DecisionRecord {
	const r: DecisionRecord = { point, subject, digest, source: d.source, outcome: d.outcome, facts: d.facts, reason: d.reason };
	const additions = d.data?.agentAdditions ?? [];
	if (additions.length > 0) r.agent_additions = additions;
	return r;
}

async function classifyOne(id: string, input: UnitInput, config: Pack["decisions"]): Promise<ClassifiedUnits> {
	const tagFacts = { title: input.title, covers: input.covers, files: input.files, doneMeans: input.done_means.map((d) => d.text), extraTags: input.extra_tags ?? [] };
	const tags = await ruleDecision("tags", tagFacts, config.tags, id);
	const tagList = tags.outcome as string[];
	const difficulty = await ruleDecision("difficulty", { tags: tagList, covers: input.covers, files: input.files }, config.difficulty, id);
	const unit: RenderableUnit = { ...input, id, difficulty: String(difficulty.outcome), tags: tagList };
	const digest = unitDigest(parsedUnit(unit));
	return { units: [unit], records: [record("tags", id, digest, tags), record("difficulty", id, digest, difficulty)] };
}

/** Classifies each unit under the id its caller allocated; records come in unit order, `tags` before `difficulty`. */
export async function classifyUnits(units: { id: string; input: UnitInput }[], config: Pack["decisions"]): Promise<ClassifiedUnits> {
	const out: ClassifiedUnits = { units: [], records: [] };
	for (const { id, input } of units) {
		const one = await classifyOne(id, input, config);
		out.units.push(...one.units);
		out.records.push(...one.records);
	}
	return out;
}
