import { beforeAll, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import type { ChangeState } from "../../src/engine/state-types.ts";
import { finishMode, laneOpenRefusal, refactorPendingRefusal, unitFinishRefusal, unitStartRefusal } from "../../src/evidence/refusals.ts";
import type { ReceiptRecord, StartRecord } from "../../src/evidence/records.ts";
import { stateFor } from "../helpers/change-state.ts";

let pack: Pack;

beforeAll(async () => {
	const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
	if (!loaded.ok) throw new Error("default pack must load");
	pack = loaded.pack;
});

function unitBlock(id: string, o: { depends?: string; kind?: string; status?: string } = {}): string {
	return [
		`### ${id} — Unit ${id}`,
		"Covers: rate-limit/Requirement: Per-IP cap",
		"Difficulty: low",
		"Tags: []",
		`Files: src/${id}.ts`,
		"Done means:",
		"- [a] works",
		"Scenarios:",
		`- [a] test/${id}.test.ts › works`,
		`Depends: ${o.depends ?? "—"}`,
		"Verify: `sh check.sh`",
		...(o.kind ? [`Kind: ${o.kind}`] : []),
		o.status ?? "- [ ] pending",
	].join("\n");
}

const BODY = ["Base: abc", "Branch: livespec/per-ip-cap", "", "## Units", unitBlock("U1"), "", unitBlock("U2"), "", unitBlock("U3", { depends: "U1" }), "", unitBlock("U4", { status: "- [x] done" }), ""].join("\n");
const CHANGE = parseChange(BODY);
const digestOf = (id: string): string => unitDigest(CHANGE.units.find((u) => u.id === id)!);
const LOCKED = Object.fromEntries(CHANGE.units.map((u) => [u.id, unitDigest(u)]));

const start = (unit: string, digest = digestOf(unit), index = 0): StartRecord => ({
	unit,
	digest,
	verify: "sh check.sh",
	pre: { sha: "a".repeat(40), exit: 1, verdict: "red" },
	id: `${unit}.x`,
	commentId: "1",
	index,
});

const receipt = (unit: string): ReceiptRecord => ({
	unit,
	digest: digestOf(unit),
	verify: "sh check.sh",
	pre: { sha: "a".repeat(40), exit: 1 },
	post: { sha: "b".repeat(40), exit: 0 },
	output: "",
	start: `${unit}.x`,
	id: `${unit}.y`,
	commentId: "2",
	index: 1,
});

type Patch = { dirty?: boolean; frozen?: string[]; stale?: string[]; started?: Record<string, StartRecord>; blocked?: Record<string, "attempts" | "progress">; unticked?: string[]; locked?: boolean; phase?: string; staleState?: boolean };

/** A build-phase state over BODY with every unit locked; `p` sets what a row needs. */
function state(p: Patch = {}): ChangeState {
	const base = stateFor(p.phase ?? "build", {}, BODY);
	return {
		...base,
		stale: p.staleState ?? false,
		git: { ...base.git, dirty: p.dirty ?? false },
		lock: { locked: p.locked === false ? undefined : LOCKED, frozen: p.frozen ?? [], staleUnits: p.stale ?? [], gates: {} },
		evidence: { started: p.started ?? {}, receipts: p.unticked ? Object.fromEntries(p.unticked.map((u) => [u, [receipt(u)]])) : {}, attempts: {}, blocked: p.blocked ?? {}, untickedReceipts: p.unticked ?? [] },
	};
}

describe("laneOpenRefusal", () => {
	type Row = [name: string, unit: string, patch: Patch, expected: string | undefined];
	const rows: Row[] = [
		["not a per: unit phase", "U1", { phase: "plan" }, "per: unit"],
		["no lock", "U1", { locked: false }, "not locked"],
		["unknown unit", "U9", {}, "U9 is not"],
		["frozen unit", "U1", { frozen: ["U1"] }, "unit_amend"],
		["stale unit", "U1", { stale: ["U1"] }, "unit_amend"],
		["blocked unit", "U1", { blocked: { U1: "attempts" } }, "spec_stuck"],
		["a ready unit may open a lane", "U1", {}, undefined],
	];

	test.each(rows)("%s", (_name, unit, patch, expected) => {
		const refusal = laneOpenRefusal(state(patch), pack, unit);
		if (expected === undefined) expect(refusal).toBeUndefined();
		else expect(refusal).toContain(expected);
	});
});

describe("unitStartRefusal", () => {
	type Row = [name: string, unit: string, patch: Patch, expected: string | undefined];
	const rows: Row[] = [
		["not a per: unit phase", "U1", { phase: "plan" }, "per: unit"],
		["no lock", "U1", { locked: false }, "not locked"],
		["unknown unit", "U9", {}, "U9 is not"],
		["done unit", "U4", {}, "U4 is already done"],
		["Frozen unit", "U1", { frozen: ["U1"] }, "unit_amend"],
		["stale unit", "U1", { stale: ["U1"] }, "unit_amend"],
		["Unmet dependency", "U3", {}, "U1"],
		["blocked unit", "U1", { blocked: { U1: "attempts" } }, "spec_stuck"],
		["already started with its current digest", "U1", { started: { U1: start("U1") } }, "already started"],
		["Dirty tree", "U1", { dirty: true }, "commit"],
		["One started unit at a time", "U2", { started: { U1: start("U1") } }, "U1"],
		["restart after an amendment is allowed", "U1", { started: { U1: start("U1", "old-digest") } }, undefined],
		["stale change state", "U1", { staleState: true }, "the change state is stale (forge unreachable or login unknown); retry when the forge is reachable"],
		["a ready unit starts", "U1", {}, undefined],
	];

	test.each(rows)("%s", (_name, unit, patch, expected) => {
		const refusal = unitStartRefusal(state(patch), pack, unit);
		if (expected === undefined) expect(refusal).toBeUndefined();
		else expect(refusal).toContain(expected);
	});

	test("the first refusal in D10 order wins", () => {
		// Frozen comes before dirty and before another started unit.
		const refusal = unitStartRefusal(state({ frozen: ["U2"], dirty: true, started: { U1: start("U1") } }), pack, "U2");
		expect(refusal).toContain("unit_amend");
		// Dirty comes before another started unit.
		expect(unitStartRefusal(state({ dirty: true, started: { U1: start("U1") } }), pack, "U2")).toContain("commit");
		// Unmet dependency comes before blocked.
		expect(unitStartRefusal(state({ blocked: { U3: "progress" } }), pack, "U3")).toContain("U1");
	});

	test("refactor-pending refusal", () => {
		const refactor = parseChange(["## Units", unitBlock("U5", { kind: "refactor" })].join("\n")).units[0]!;
		expect(refactorPendingRefusal(refactor, true)).toContain("a refactor needs an existing test");
		expect(refactorPendingRefusal(refactor, false)).toBeUndefined();
		expect(refactorPendingRefusal(CHANGE.units[0]!, true)).toBeUndefined();
	});
});

describe("unitFinishRefusal", () => {
	test("finishMode is reconcile only for a receipted, unticked unit", () => {
		expect(finishMode(state({ unticked: ["U1"] }), "U1")).toBe("reconcile");
		expect(finishMode(state({ started: { U1: start("U1") } }), "U1")).toBe("run");
		expect(finishMode(state(), "U1")).toBe("run");
	});

	type Row = [name: string, unit: string, patch: Patch, mode: "run" | "reconcile", expected: string | undefined];
	const rows: Row[] = [
		["Not started", "U1", {}, "run", "unit_start U1"],
		["done unit has nothing to finish", "U4", {}, "run", "nothing to finish"],
		["Digest changed since start", "U1", { started: { U1: start("U1", "old-digest") } }, "run", "unit_amend"],
		["frozen started unit", "U1", { started: { U1: start("U1") }, frozen: ["U1"] }, "run", "unit_amend"],
		["blocked started unit", "U1", { started: { U1: start("U1") }, blocked: { U1: "attempts" } }, "run", "spec_stuck"],
		["dirty tree in run mode", "U1", { started: { U1: start("U1") }, dirty: true }, "run", "commit"],
		["stale change state in run mode", "U1", { started: { U1: start("U1") }, staleState: true }, "run", "the change state is stale (forge unreachable or login unknown); retry when the forge is reachable"],
		["a started unit runs", "U1", { started: { U1: start("U1") } }, "run", undefined],
		["reconcile: dirty tree refuses", "U1", { unticked: ["U1"], dirty: true }, "reconcile", "commit"],
		["reconcile: frozen unit refuses", "U1", { unticked: ["U1"], frozen: ["U1"] }, "reconcile", "unit_amend"],
		["reconcile: stale unit refuses", "U1", { unticked: ["U1"], stale: ["U1"] }, "reconcile", "unit_amend"],
		["reconcile: blocked does not apply", "U1", { unticked: ["U1"], blocked: { U1: "attempts" } }, "reconcile", undefined],
		["reconcile: a clean, unchanged unit ticks", "U1", { unticked: ["U1"] }, "reconcile", undefined],
	];

	test.each(rows)("%s", (_name, unit, patch, mode, expected) => {
		const refusal = unitFinishRefusal(state(patch), pack, unit, mode);
		if (expected === undefined) expect(refusal).toBeUndefined();
		else expect(refusal).toContain(expected);
	});

	test("a finish outside a per: unit phase is refused", () => {
		expect(unitFinishRefusal(state({ phase: "define", started: { U1: start("U1") } }), pack, "U1", "run")).toContain("not in a per: unit phase (phase define)");
		expect(unitFinishRefusal(state({ phase: "plan", unticked: ["U1"] }), pack, "U1", "reconcile")).toContain("not in a per: unit phase (phase plan)");
	});

	test("not started comes before a dirty tree", () => {
		expect(unitFinishRefusal(state({ dirty: true }), pack, "U1", "run")).toContain("unit_start U1");
	});
});
