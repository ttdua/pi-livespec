// Human overrides of a unit's Difficulty or Tags at an approved plan or
// amendment gate (design D10): a byte-preserving line rewrite plus a `decision`
// record with `source: human` and `overridden_by`. Both steps are idempotent.

import { parseChange } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import { setUnitField } from "../core/unit-blocks.ts";
import { decisionComment, type DecisionRecord, latestDecisions } from "../decide/records.ts";
import type { Answered, Override } from "./approver.ts";
import { appendRecord, editBody, readIssue, type Run } from "./complete-effects.ts";

type Field = { point: "difficulty" | "tags"; field: "Difficulty" | "Tags"; value: unknown; text: string };

function fieldsOf(o: Override): Field[] {
	const fields: Field[] = [];
	if (o.difficulty !== undefined) fields.push({ point: "difficulty", field: "Difficulty", value: o.difficulty, text: o.difficulty });
	if (o.tags !== undefined) fields.push({ point: "tags", field: "Tags", value: o.tags, text: `[${o.tags.join(", ")}]` });
	return fields;
}

/**
 * The value before the override: the outcome of the latest record for the unit, else the body value.
 * Only called before this request's own record exists, so a retry never reads its own outcome.
 */
function previous(run: Run, f: Field, unit: string, body: string): unknown {
	const latest = latestDecisions(run.marked).get(`${f.point}.${unit}`);
	if (latest) return latest.outcome;
	const u = parseChange(body).units.find((x) => x.id === unit);
	return f.point === "tags" ? u?.tags : u?.difficulty;
}

/**
 * Whether this answer's override record exists. Effect records carry no `request`: a `decision` with
 * `request` completes a request (`readRequests`), and only the result record may do that.
 */
function hasOverride(run: Run, id: string, answer: Answered): boolean {
	return run.marked.some((m) => {
		const by = (m.data as Partial<DecisionRecord> | null)?.overridden_by;
		return m.kind === "decision" && m.id === id && by?.by === answer.by && by.at === answer.at;
	});
}

async function recordOverride(run: Run, f: Field, unit: string, answer: Answered, from: unknown): Promise<void> {
	const u = parseChange((await readIssue(run)).body).units.find((x) => x.id === unit);
	const record: DecisionRecord = {
		point: f.point,
		subject: unit,
		source: "human",
		outcome: f.value,
		reason: `set by ${answer.by} at the gate`,
		overridden_by: { by: answer.by, at: answer.at, from },
	};
	if (u) record.digest = unitDigest(u);
	await appendRecord(run, decisionComment(record));
}

/** Applies every override of `answer` to units present in the body. */
export async function applyOverrides(run: Run, answer: Answered): Promise<void> {
	for (const o of answer.overrides ?? []) {
		for (const f of fieldsOf(o)) {
			const body = (await readIssue(run)).body;
			if (!parseChange(body).units.some((u) => u.id === o.unit)) continue;
			if (hasOverride(run, `${f.point}.${o.unit}`, answer)) continue;
			const from = previous(run, f, o.unit, body);
			await editBody(run, (b) => setUnitField(b, o.unit, f.field, f.text));
			await recordOverride(run, f, o.unit, answer, from);
		}
	}
}
