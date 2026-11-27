import { describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { deriveLocks } from "../../src/engine/locks.ts";
import type { Pack, Phase } from "../../src/engine/pack-types.ts";
import { REMOVED_DIGEST } from "../../src/engine/requirement-diff.ts";
import type { PhaseState } from "../../src/engine/state-types.ts";
import type { MarkedComment } from "../../src/forge/markers.ts";
import { acknowledgedDigests, type CascadeInput, excludedIds, isBaselineStale, isSpecCascade, needsMoveBack, planSpecCascade, type SpecCascadePlan } from "../../src/interaction/spec-cascade-plan.ts";

const CAP = "rate-limit/Requirement: Per-IP cap";
const BURST = "rate-limit/Requirement: Burst";
const RETENTION = "audit-log/Requirement: Retention";
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const LATER = ["plan", "build", "review", "ship", "close"];

function phase(id: string, requires: string[], gate: Phase["gate"] = "human", per?: "unit"): Phase {
	return { id, requires, gate, skills: { required: [], optional: [] }, outputs: [], redirects: [], checks: [], subagents: [], ...(per ? { per } : {}) };
}

function packWith(defineGate: Phase["gate"] = "human"): Pack {
	const phases = [phase("shape", [], "self"), phase("define", ["shape"], defineGate), phase("plan", ["define"]), phase("build", ["plan"], "none", "unit"), phase("review", ["build"], "self"), phase("ship", ["review"]), phase("close", ["ship"], "none")];
	return { name: "t", version: 1, content: "", limits: {}, loops: {}, decisions: {}, init: { skills: [] }, phases };
}

type U = { id: string; covers: string; done: boolean };

function unit(u: U): string {
	return [`### ${u.id} — Unit ${u.id}`, `Covers: ${u.covers}`, "Difficulty: low", "Tags: []", `Files: src/${u.id}.ts`, "Done means:", "- [a] works", "Scenarios:", `- [a] t.test.ts › ${u.id}`, "Depends: —", "Verify: `true`", u.done ? "- [x] done" : "- [ ] pending", ""].join("\n");
}

const UNITS: U[] = [
	{ id: "U2", covers: BURST, done: true },
	{ id: "U3", covers: CAP, done: true },
	{ id: "U4", covers: CAP, done: false },
];

function bodyOf(units: U[]): string {
	return ["Capabilities: new [], modified [rate-limit]", "", "## Proposal", "p", "## Units", ...units.map(unit)].join("\n");
}

let seq = 0;
function marked(kind: string, id: string, data: unknown): MarkedComment {
	seq += 1;
	return { commentId: `c${seq}`, kind, id, author: "bot", data };
}

const planGate = (record?: Record<string, string>): MarkedComment =>
	marked("gate", `plan.r${seq}`, { phase: "plan", outcome: "approved", notes: "", by: "alice", at: "t", adapter: "forge", head_sha: "f".repeat(40), waivers: [], locked: {}, ...(record ? { requirements: record, requirement_scope: ["rate-limit"] } : {}) });
const defineGate = (): MarkedComment => marked("gate", `define.r${seq}`, { phase: "define", outcome: "approved", notes: "", by: "alice", at: "t", adapter: "forge", head_sha: "f", waivers: [] });

const ok = (id: string): PhaseState => ({ kind: "ok", id });

type Over = { units?: U[]; marked?: MarkedComment[]; phase?: PhaseState; pack?: Pack; baseline?: Record<string, string> | undefined; heads?: Record<string, string>; reference?: Record<string, string>; scope?: string[] };

/** A locked change in build whose baseline is `{ CAP: A, BURST: A }` unless overridden. */
function inputOf(o: Over = {}): CascadeInput {
	const baseline = "baseline" in o ? o.baseline : { [CAP]: A, [BURST]: A };
	const change = parseChange(bodyOf(o.units ?? UNITS));
	const markedList = o.marked ?? [planGate(baseline)];
	return {
		change,
		marked: markedList,
		phase: o.phase ?? ok("build"),
		pack: o.pack ?? packWith(),
		lock: deriveLocks(change, markedList),
		baseline,
		scope: o.scope ?? ["rate-limit"],
		heads: o.heads ?? { [CAP]: A, [BURST]: A },
		reference: o.reference,
	};
}

/** The plan's `stale` comment as the runner would post it. */
function posted(plan: SpecCascadePlan): MarkedComment {
	if (plan.kind !== "cascade" && plan.kind !== "legacy-missing") throw new Error(`no comment in a ${plan.kind} plan`);
	return marked("stale", plan.id, plan.data);
}

function cascadeOf(plan: SpecCascadePlan): Extract<SpecCascadePlan, { kind: "cascade" }> {
	if (plan.kind !== "cascade") throw new Error(`expected a cascade, got ${plan.kind}`);
	return plan;
}

const unitsOf = (input: CascadeInput): U[] => input.change.units.map((u) => ({ id: u.id, covers: u.covers.join(", "), done: u.done }));

/** Applies a cascade as the runner would: posts the comment, unticks the done units, moves to define. */
function applied(input: CascadeInput, plan: SpecCascadePlan): CascadeInput {
	const c = cascadeOf(plan);
	const units = unitsOf(input).map((u) => (c.untick.includes(u.id) ? { ...u, done: false } : u));
	return inputOf({ ...input, units, marked: [...input.marked, posted(plan)], phase: ok("define") });
}

describe("planSpecCascade", () => {
	test("no lock → none", () => {
		const input = inputOf({ marked: [], heads: { [CAP]: B, [BURST]: A } });
		expect(planSpecCascade(input)).toEqual({ kind: "none" });
	});

	test("covered done unit → cascade", () => {
		const plan = cascadeOf(planSpecCascade(inputOf({ heads: { [CAP]: B, [BURST]: A } })));
		expect(plan.data).toMatchObject({ units: ["U3", "U4"], phases: ["define", ...LATER], after_plan: true, requirements: { [CAP]: B } });
		expect(plan.data.reason).toBe(`requirements changed since the plan lock: ${CAP}`);
		expect(plan.untick).toEqual(["U3"]);
		expect(plan.moveBack).toBe(true);
		expect(plan.id).toMatch(/^spec\.[0-9a-f]{12}$/);
	});

	test("covered done unit names only covering units", () => {
		const units = UNITS.filter((u) => u.id !== "U4");
		const plan = cascadeOf(planSpecCascade(inputOf({ units, heads: { [CAP]: B, [BURST]: A } })));
		expect(plan.data.units).toEqual(["U3"]);
		expect(plan.untick).toEqual(["U3"]);
		expect(plan.data.after_plan).toBe(true);
	});

	test("uncovered edit → cascade with no units", () => {
		const units = UNITS.filter((u) => u.id === "U3");
		const plan = cascadeOf(planSpecCascade(inputOf({ units, heads: { [CAP]: A, [BURST]: B } })));
		expect(plan.data.units).toEqual([]);
		expect(plan.untick).toEqual([]);
		expect(plan.moveBack).toBe(true);
	});

	test("pending unit covering the edit is named but not unticked", () => {
		const plan = cascadeOf(planSpecCascade(inputOf({ heads: { [CAP]: B, [BURST]: A } })));
		expect(plan.data.units).toContain("U4");
		expect(plan.untick).not.toContain("U4");
	});

	test("same digest already acknowledged → none", () => {
		const input = inputOf({ heads: { [CAP]: B, [BURST]: A } });
		expect(planSpecCascade(applied(input, planSpecCascade(input)))).toEqual({ kind: "none" });
	});

	test("further edit (new digest) → cascade naming U3 again", () => {
		const first = inputOf({ heads: { [CAP]: B, [BURST]: A } });
		const after = applied(first, planSpecCascade(first));
		const plan = cascadeOf(planSpecCascade({ ...after, heads: { [CAP]: C, [BURST]: A } }));
		expect(plan.data.units).toContain("U3");
		expect(plan.data.requirements).toEqual({ [CAP]: C });
	});

	test("baseline A, edits B, A, B → three cascades with distinct ids", () => {
		let input = inputOf({ heads: { [CAP]: B, [BURST]: A } });
		const ids: string[] = [];
		for (const digest of [B, A, B]) {
			input = { ...input, heads: { [CAP]: digest, [BURST]: A } };
			const plan = cascadeOf(planSpecCascade(input));
			ids.push(plan.id);
			input = applied(input, plan);
		}
		expect(new Set(ids).size).toBe(3);
		expect(planSpecCascade(input)).toEqual({ kind: "none" });
	});

	test("revert to the baseline text after a cascade → cascade", () => {
		const first = inputOf({ heads: { [CAP]: B, [BURST]: A } });
		const after = applied(first, planSpecCascade(first));
		const plan = cascadeOf(planSpecCascade({ ...after, heads: { [CAP]: A, [BURST]: A } }));
		expect(plan.data.requirements).toEqual({ [CAP]: A });
	});

	test("removed requirement → cascade with REMOVED_DIGEST", () => {
		const plan = cascadeOf(planSpecCascade(inputOf({ heads: { [CAP]: A } })));
		expect(plan.data.requirements).toEqual({ [BURST]: REMOVED_DIGEST });
		expect(plan.data.units).toEqual(["U2"]);
	});

	test("removed requirement acknowledged → none on rerun", () => {
		const first = inputOf({ heads: { [CAP]: A } });
		const after = applied(first, planSpecCascade(first));
		expect(acknowledgedDigests(after)).toEqual({ [CAP]: A });
		expect(planSpecCascade(after)).toEqual({ kind: "none" });
	});

	test("removed then re-added → cascade", () => {
		const first = inputOf({ heads: { [CAP]: A } });
		const after = applied(first, planSpecCascade(first));
		const plan = cascadeOf(planSpecCascade({ ...after, heads: { [CAP]: A, [BURST]: A } }));
		expect(plan.data.requirements).toEqual({ [BURST]: A });
	});

	test("capability outside scope is not compared", () => {
		const units = [...UNITS, { id: "U5", covers: RETENTION, done: true }];
		expect(planSpecCascade(inputOf({ units, heads: { [CAP]: A, [BURST]: A, [RETENTION]: B } }))).toEqual({ kind: "none" });
	});

	test("integration edit not acknowledged → excluded", () => {
		const input = inputOf({ heads: { [CAP]: A, [BURST]: B }, reference: { [CAP]: A, [BURST]: B } });
		expect(excludedIds(input, [BURST])).toEqual(new Set([BURST]));
		expect(planSpecCascade(input)).toEqual({ kind: "none" });
	});

	test("integration removal merged → excluded", () => {
		expect(planSpecCascade(inputOf({ heads: { [CAP]: A }, reference: { [CAP]: A } }))).toEqual({ kind: "none" });
	});

	test("conflict combined from both sides is not excluded", () => {
		const plan = cascadeOf(planSpecCascade(inputOf({ heads: { [CAP]: C, [BURST]: A }, reference: { [CAP]: B, [BURST]: A } })));
		expect(plan.data.requirements).toEqual({ [CAP]: C });
	});

	test("own edit reverted equals reference → not excluded", () => {
		const first = inputOf({ heads: { [CAP]: B, [BURST]: A } });
		const after = applied(first, planSpecCascade(first));
		const reverted = { ...after, heads: { [CAP]: A, [BURST]: A }, reference: { [CAP]: A, [BURST]: A } };
		expect(excludedIds(reverted, [CAP])).toEqual(new Set());
		expect(cascadeOf(planSpecCascade(reverted)).data.requirements).toEqual({ [CAP]: A });
	});

	test("second edit while in define → cascade with after_plan false", () => {
		const first = inputOf({ heads: { [CAP]: B, [BURST]: A } });
		const after = applied(first, planSpecCascade(first));
		const plan = cascadeOf(planSpecCascade({ ...after, heads: { [CAP]: B, [BURST]: B } }));
		expect(plan.data.requirements).toEqual({ [BURST]: B });
		expect(plan.data.after_plan).toBe(false);
		expect(plan.moveBack).toBe(false);
		expect(plan.untick).toEqual(["U2"]);
	});

	test("partial earlier cascade → complete", () => {
		const first = inputOf({ heads: { [CAP]: B, [BURST]: A } });
		const plan = planSpecCascade(first);
		// The comment was posted; the untick and the move did not happen: U3 still ticked, still in build.
		const partial = { ...first, marked: [...first.marked, posted(plan)] };
		const next = planSpecCascade({ ...partial, lock: deriveLocks(partial.change, partial.marked) });
		expect(next).toEqual({ kind: "complete", untick: ["U3"], moveBack: true });
	});

	test("completion without untick still moves back when the phase did not move", () => {
		const first = inputOf({ heads: { [CAP]: B, [BURST]: A } });
		const plan = planSpecCascade(first);
		const units = UNITS.map((u) => (u.id === "U3" ? { ...u, done: false } : u));
		const partial = inputOf({ ...first, units, marked: [...first.marked, posted(plan)] });
		expect(planSpecCascade(partial)).toEqual({ kind: "complete", untick: [], moveBack: true });
	});

	test("completion does not move back past a later define approval", () => {
		const first = inputOf({ heads: { [CAP]: B, [BURST]: A } });
		const plan = planSpecCascade(first);
		const units = UNITS.map((u) => (u.id === "U3" ? { ...u, done: false } : u));
		const approvedAgain = inputOf({ ...first, units, marked: [...first.marked, posted(plan), defineGate()], phase: ok("plan") });
		expect(planSpecCascade(approvedAgain)).toEqual({ kind: "none" });
	});

	test("locked, no define gate, no spec stale → none", () => {
		expect(planSpecCascade(inputOf())).toEqual({ kind: "none" });
	});

	test("legacy commit gone in build → legacy-missing", () => {
		const input = inputOf({ baseline: undefined, marked: [planGate()] });
		const plan = planSpecCascade(input);
		expect(plan).toEqual({
			kind: "legacy-missing",
			id: `baseline.${"f".repeat(12)}`,
			data: { reason: `the plan-lock commit ${"f".repeat(40)} is missing; approve the spec and the plan again`, phases: ["define", ...LATER], units: [], after_plan: false, baseline: "f".repeat(40) },
			moveBack: true,
		});
		expect(isBaselineStale(posted(plan))).toBe(true);
		expect(isSpecCascade(posted(plan))).toBe(false);
	});

	test("legacy comment exists, move failed → complete with moveBack", () => {
		const input = inputOf({ baseline: undefined, marked: [planGate()] });
		const withComment = inputOf({ ...input, baseline: undefined, marked: [...input.marked, posted(planSpecCascade(input))] });
		expect(planSpecCascade(withComment)).toEqual({ kind: "complete", untick: [], moveBack: true });
	});

	test("legacy comment exists, in define → none", () => {
		const input = inputOf({ baseline: undefined, marked: [planGate()] });
		const withComment = inputOf({ ...input, baseline: undefined, marked: [...input.marked, posted(planSpecCascade(input))], phase: ok("define") });
		expect(planSpecCascade(withComment)).toEqual({ kind: "none" });
		const approved = inputOf({ ...withComment, baseline: undefined, marked: [...withComment.marked, defineGate()], phase: ok("plan") });
		expect(planSpecCascade(approved)).toEqual({ kind: "none" });
	});

	test("legacy commit gone in define → legacy-missing without moveBack", () => {
		const plan = planSpecCascade(inputOf({ baseline: undefined, marked: [planGate()], phase: ok("define") }));
		expect(plan).toMatchObject({ kind: "legacy-missing", moveBack: false, data: { after_plan: false } });
	});

	test("define gate none in pack → completion does not move back", () => {
		const pack = packWith("none");
		const first = inputOf({ pack, heads: { [CAP]: B, [BURST]: A } });
		const plan = planSpecCascade(first);
		const units = UNITS.map((u) => (u.id === "U3" ? { ...u, done: false } : u));
		const partial = inputOf({ ...first, units, marked: [...first.marked, posted(plan)] });
		expect(planSpecCascade(partial)).toEqual({ kind: "none" });
	});

	test("covers entry with extra whitespace matches", () => {
		const units = [{ id: "U3", covers: "  rate-limit/Requirement:  Per-IP   cap ", done: true }];
		const plan = cascadeOf(planSpecCascade(inputOf({ units, heads: { [CAP]: B, [BURST]: A } })));
		expect(plan.data.units).toEqual(["U3"]);
		expect(plan.untick).toEqual(["U3"]);
	});

	test("id is stable across input order", () => {
		const gate = [planGate({ [CAP]: A, [BURST]: A })];
		const one = cascadeOf(planSpecCascade(inputOf({ marked: gate, heads: { [CAP]: B, [BURST]: C } })));
		const other = cascadeOf(planSpecCascade(inputOf({ marked: gate, heads: { [BURST]: C, [CAP]: B }, baseline: { [BURST]: A, [CAP]: A } })));
		expect(other.id).toBe(one.id);
		expect(one.data.reason).toBe(`requirements changed since the plan lock: ${BURST}, ${CAP}`);
	});
});

describe("needsMoveBack", () => {
	test("past define, or half-moved with define and a later phase", () => {
		const pack = packWith();
		expect(needsMoveBack(pack, ok("build"))).toBe(true);
		expect(needsMoveBack(pack, ok("define"))).toBe(false);
		expect(needsMoveBack(pack, ok("shape"))).toBe(false);
		expect(needsMoveBack(pack, { kind: "ambiguous", ids: ["define", "build"] })).toBe(true);
		expect(needsMoveBack(pack, { kind: "ambiguous", ids: ["shape", "build"] })).toBe(false);
		expect(needsMoveBack(pack, { kind: "missing" })).toBe(false);
	});
});
