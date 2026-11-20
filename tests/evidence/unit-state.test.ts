import { describe, expect, test } from "vitest";
import { type Change, parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { rebuildComment, type ReceiptData, type StartData } from "../../src/evidence/records.ts";
import { budgetWindow, deriveUnitEvidence } from "../../src/evidence/unit-state.ts";
import type { MarkedComment } from "../../src/forge/markers.ts";

const unitBlock = (n: number, done: boolean): string =>
	`### U${n} — t${n}\nCovers: c/Requirement: R\nFiles: src/a${n}.ts\nDone means:\n- [a] x\nScenarios:\n- [a] t › x\nDepends: —\nVerify: \`bun test a${n}\`\n- [${done ? "x" : " "}] ${done ? "done" : "pending"}\n`;

/** U1 and U2 pending, U3 done unless `doneU2` also ticks U2. */
function change(doneU2 = false): Change {
	return parseChange(`## Units\n${unitBlock(1, false)}\n${unitBlock(2, doneU2)}\n${unitBlock(3, true)}`);
}

const digestOf = (c: Change, id: string): string => unitDigest(c.units.find((u) => u.id === id) as Change["units"][number]);

let seq = 0;
function m(kind: string, id: string, data: unknown): MarkedComment {
	seq += 1;
	return { commentId: `c${seq}`, kind, id, author: "bot", data };
}

const startData = (unit: string, digest = "d"): StartData => ({
	unit,
	digest,
	verify: `bun test`,
	pre: { sha: "a".repeat(40), exit: 1, verdict: "red", output: "" },
});
const start = (unit: string, digest = "d", suffix = "s"): MarkedComment => m("unit-start", `${unit}.${suffix}`, startData(unit, digest));
const receiptData = (unit: string, digest: string, startId: string): ReceiptData => ({
	unit,
	digest,
	verify: "bun test",
	pre: { sha: "a".repeat(40), exit: 1 },
	post: { sha: "b".repeat(40), exit: 0 },
	output: "",
	start: startId,
});
const receipt = (unit: string, digest = "d", suffix = "r"): MarkedComment => m("receipt", `${unit}.${suffix}`, receiptData(unit, digest, `${unit}.s`));
const progress = (unit: string, outcome: "retry" | "stop", attempt = 1): MarkedComment =>
	m("decision", `progress.${unit}`, {
		point: "progress",
		subject: unit,
		digest: "d",
		source: "rule",
		outcome,
		reason: "r",
		attempt,
		signature: { tests: [], hash: String(attempt) },
	});
const stuckAnswer = (outcome: string, choice = "B"): MarkedComment =>
	m("stuck", "S1-answer", { request: "stuck-S1.x", outcome, choice, notes: "", by: "alice", at: "t", adapter: "forge" });

describe("budgetWindow", () => {
	test("is the latest start, receipt or lifting stuck answer", () => {
		expect(budgetWindow([], "U1")).toBe(-1);
		expect(budgetWindow([progress("U1", "retry"), start("U1"), progress("U1", "retry")], "U1")).toBe(1);
		expect(budgetWindow([start("U1"), receipt("U1"), start("U2")], "U1")).toBe(1);
		expect(budgetWindow([start("U1"), progress("U1", "stop"), stuckAnswer("approved")], "U1")).toBe(2);
	});
});

describe("deriveUnitEvidence", () => {
	test("Started unit from comments", () => {
		const ev = deriveUnitEvidence(change(), [start("U2")], 3);
		expect(Object.keys(ev.started)).toEqual(["U2"]);
		expect(ev.started.U2).toMatchObject({ unit: "U2", id: "U2.s", index: 0 });
	});

	test("a receipt after the start ends the started state", () => {
		const ev = deriveUnitEvidence(change(), [start("U2"), receipt("U2")], 3);
		expect(ev.started).toEqual({});
		expect(ev.receipts.U2).toHaveLength(1);
	});

	test("Done unit is never started", () => {
		const ev = deriveUnitEvidence(change(true), [start("U2")], 3);
		expect(ev.started).toEqual({});
	});

	test("Derived unit attempts", () => {
		const marked = [progress("U2", "retry"), start("U2"), progress("U2", "retry", 1), progress("U2", "retry", 2), m("counter", "unit_attempts.U2", { value: 9 })];
		expect(deriveUnitEvidence(change(), marked, 3).attempts.U2).toBe(2);
	});

	test("attempts reset after a receipt", () => {
		const marked = [start("U1"), progress("U1", "retry"), receipt("U1"), progress("U1", "retry")];
		expect(deriveUnitEvidence(change(), marked, 3).attempts.U1).toBe(1);
	});

	test("attempts reset after a lifting stuck answer", () => {
		const marked = [start("U1"), progress("U1", "retry"), progress("U1", "retry", 2), stuckAnswer("approved_with_notes"), progress("U1", "retry")];
		expect(deriveUnitEvidence(change(), marked, 3).attempts.U1).toBe(1);
	});

	test("Chosen stuck answer restarts the budget", () => {
		const marked = [start("U1"), progress("U1", "retry"), progress("U1", "retry", 2), progress("U1", "stop", 3), stuckAnswer("approved", "B")];
		const ev = deriveUnitEvidence(change(), marked, 3);
		expect(ev.blocked).toEqual({});
		expect(ev.attempts.U1).toBe(0);
	});

	test("Dismissed stuck answer keeps the block", () => {
		const marked = [start("U1"), progress("U1", "retry"), progress("U1", "retry", 2), progress("U1", "stop", 3), stuckAnswer("dismissed", "")];
		const ev = deriveUnitEvidence(change(), marked, 3);
		expect(ev.blocked).toEqual({ U1: "attempts" });
		expect(ev.attempts.U1).toBe(3);
	});

	test("blocked attempts at the cap", () => {
		const marked = [start("U1"), progress("U1", "retry"), progress("U1", "retry", 2)];
		expect(deriveUnitEvidence(change(), marked, 2).blocked).toEqual({ U1: "attempts" });
		expect(deriveUnitEvidence(change(), marked, 3).blocked).toEqual({});
		expect(deriveUnitEvidence(change(), marked, undefined).blocked).toEqual({});
	});

	test("blocked progress on a stop record", () => {
		const marked = [start("U1"), progress("U1", "retry"), progress("U1", "stop", 2)];
		const ev = deriveUnitEvidence(change(), marked, 3);
		expect(ev.blocked).toEqual({ U1: "progress" });
		expect(ev.attempts.U1).toBe(2);
	});

	test("untickedReceipts", () => {
		const c = change();
		const d1 = digestOf(c, "U1");
		const d2 = digestOf(c, "U2");
		const marked = [start("U1", d1), receipt("U1", d1), start("U2", d2), receipt("U2", "stale-digest"), receipt("U3", digestOf(c, "U3"))];
		expect(deriveUnitEvidence(c, marked, 3).untickedReceipts).toEqual(["U1"]);
		const restarted = [start("U1", d1), receipt("U1", d1), start("U1", d1, "s2")];
		const ev = deriveUnitEvidence(c, restarted, 3);
		expect(ev.untickedReceipts).toEqual([]);
		expect(Object.keys(ev.started)).toEqual(["U1"]);
	});

	describe("rebuild", () => {
		const rebuild = (unit: string, round = 1): MarkedComment => m("rebuild", `rebuild.${unit}.${round}`, { unit, round, finding: "c1:0" });

		test("rebuildComment writes the rebuild marker", () => {
			expect(rebuildComment({ unit: "U2", round: 1, finding: "c1:0" })).toContain("rebuild.U2.1");
		});

		test("a rebuild newer than the receipt is not unticked and is listed", () => {
			const c = change();
			const d2 = digestOf(c, "U2");
			const ev = deriveUnitEvidence(c, [start("U2", d2), receipt("U2", d2), rebuild("U2", 2)], 3);
			expect(ev.untickedReceipts).toEqual([]);
			expect(ev.rebuilds).toEqual({ U2: { round: 2, finding: "c1:0" } });
		});

		test("a later unit-start or receipt ends the rebuild", () => {
			const c = change();
			const d2 = digestOf(c, "U2");
			const started = deriveUnitEvidence(c, [start("U2", d2), receipt("U2", d2), rebuild("U2"), start("U2", d2, "s2")], 3);
			expect(started.rebuilds ?? {}).toEqual({});
			const receipted = deriveUnitEvidence(c, [start("U2", d2), receipt("U2", d2), rebuild("U2"), start("U2", d2, "s2"), receipt("U2", d2, "r2")], 3);
			expect(receipted.rebuilds ?? {}).toEqual({});
			expect(receipted.untickedReceipts).toEqual(["U2"]);
		});
	});
});
