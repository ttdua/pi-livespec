import { describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { readCounters } from "../../src/engine/counters.ts";
import { deriveUnitEvidence } from "../../src/evidence/unit-state.ts";
import type { MarkedComment } from "../../src/forge/markers.ts";
import type { LedgerKind } from "../../src/core/record-kinds.ts";
import type { LedgerEntry } from "../../src/ledger/entry.ts";
import { lastForgeRef, matchesRef, mergeRecords } from "../../src/ledger/merge.ts";

const comment = (ref: string, kind: string, id: string, createdAt: string, data: unknown = {}): MarkedComment => ({ ref, source: "forge", kind, id, author: "bot", data, createdAt });

const entry = (ref: string, kind: LedgerKind, id: string, seq: number, at: string, o: { after?: string; from?: string; data?: unknown } = {}): LedgerEntry => ({
	ref,
	kind,
	id,
	seq,
	at,
	...(o.after === undefined ? {} : { after: o.after }),
	...(o.from === undefined ? {} : { from: o.from }),
	data: o.data ?? {},
});

const refs = (list: MarkedComment[]): string[] => list.map((m) => m.ref);
const T = (s: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

const UNITS = [2, 3]
	.map((n) => `### U${n} — t\nCovers: c/Requirement: R\nFiles: a${n}.ts\nDone means:\n- [a] x\nScenarios:\n- [a] t › x\nDepends: —\nVerify: \`t${n}\`\n- [ ] pending\n`)
	.join("\n");
const CHANGE = parseChange(`## Units\n${UNITS}`);
const digestOf = (id: string): string => unitDigest(CHANGE.units.find((u) => u.id === id) as (typeof CHANGE.units)[number]);
const SHA = "a".repeat(40);

describe("mergeRecords", () => {
	test("Receipt before a later rebuild", () => {
		const start = entry("U2.s~00000001", "unit-start", "U2.s", 1, T(1), { data: { unit: "U2", digest: digestOf("U2"), verify: "t2", pre: { sha: SHA } } });
		const receipt = entry("U2.r~00000002", "receipt", "U2.r", 2, T(8), { after: "c7", data: { unit: "U2", digest: digestOf("U2"), verify: "t2", pre: { sha: SHA, exit: 1 }, post: { sha: SHA, exit: 0 }, output: "", start: "U2.s" } });
		const comments = [comment("c7", "gate", "plan", T(7)), comment("c9", "rebuild", "rebuild.U2.1", T(9), { unit: "U2", round: 1, finding: "c1:0" })];
		const merged = mergeRecords(comments, [start, receipt]);
		expect(refs(merged)).toEqual(["U2.s~00000001", "c7", "U2.r~00000002", "c9"]);
		expect(deriveUnitEvidence(CHANGE, merged, undefined).untickedReceipts).not.toContain("U2");
	});

	test("Unit start after a park", () => {
		const park = comment("c5", "parked", "park.1", T(5), { units: [{ unit: "U3", lane: false }], waits_for: [], at: T(5) });
		const start = entry("U3.s~00000003", "unit-start", "U3.s", 1, T(4), { after: "c5", data: { unit: "U3", digest: digestOf("U3"), verify: "t3", pre: { sha: SHA } } });
		const merged = mergeRecords([park], [start]);
		expect(refs(merged)).toEqual(["c5", "U3.s~00000003"]);
		expect(Object.keys(deriveUnitEvidence(CHANGE, merged, undefined).started)).toEqual(["U3"]);
	});

	test("Latest counter after a replay", () => {
		const comments = [comment("c5", "gate", "a", T(5)), comment("c7", "gate", "b", T(7))];
		const first = entry("custom_loop~00000001", "counter", "custom_loop", 9, T(6), { after: "c5", data: { value: 1 } });
		const second = entry("custom_loop~00000002", "counter", "custom_loop", 2, T(8), { after: "c7", data: { value: 2 } });
		expect(readCounters(mergeRecords(comments, [second, first]))).toEqual({ custom_loop: 2 });
	});

	test("an entry without after follows the last comment created at or before its time", () => {
		const comments = [comment("c1", "gate", "a", T(1)), comment("c2", "gate", "b", T(3)), comment("c3", "gate", "c", T(5))];
		const merged = mergeRecords(comments, [entry("d~00000001", "decision", "d", 1, T(3))]);
		expect(refs(merged)).toEqual(["c1", "c2", "d~00000001", "c3"]);
	});

	test("an entry older than every comment comes before them", () => {
		const comments = [comment("c1", "gate", "a", T(5))];
		const merged = mergeRecords(comments, [entry("d~00000001", "decision", "d", 1, T(1))]);
		expect(refs(merged)).toEqual(["d~00000001", "c1"]);
	});

	test("an entry anchored to a deleted comment falls back to its time", () => {
		const comments = [comment("c1", "gate", "a", T(1)), comment("c3", "gate", "c", T(5))];
		const merged = mergeRecords(comments, [entry("d~00000001", "decision", "d", 1, T(3), { after: "c2" })]);
		expect(refs(merged)).toEqual(["c1", "d~00000001", "c3"]);
	});

	test("entries after the same comment keep ledger file order", () => {
		const comments = [comment("c1", "gate", "a", T(1)), comment("c2", "gate", "b", T(9))];
		const entries = [entry("x~00000001", "decision", "x", 1, T(4), { after: "c1" }), entry("y~00000002", "decision", "y", 2, T(2), { after: "c1" })];
		expect(refs(mergeRecords(comments, entries))).toEqual(["c1", "x~00000001", "y~00000002", "c2"]);
	});

	test("an entry is a ledger record with its ref, time and origin", () => {
		const [m] = mergeRecords([], [entry("d~00000001", "decision", "d", 1, T(1), { from: "c42", data: { a: 1 } })]);
		expect(m).toEqual({ ref: "d~00000001", source: "ledger", kind: "decision", id: "d", author: "", data: { a: 1 }, createdAt: T(1), from: "c42" });
	});
});

describe("matchesRef", () => {
	test("Reference by migrated comment id", () => {
		const [m] = mergeRecords([], [entry("f~00000001", "finding-summary", "f", 1, T(1), { from: "c42" })]);
		expect(m && matchesRef(m, "c42")).toBe(true);
		expect(m && matchesRef(m, "f~00000001")).toBe(true);
		expect(m && matchesRef(m, "c43")).toBe(false);
	});
});

describe("lastForgeRef", () => {
	test("is the last forge record, skipping entries", () => {
		const merged = mergeRecords([comment("c1", "gate", "a", T(1)), comment("c2", "gate", "b", T(2))], [entry("d~00000001", "decision", "d", 1, T(3), { after: "c2" })]);
		expect(lastForgeRef(merged)).toBe("c2");
		expect(lastForgeRef([])).toBeUndefined();
	});
});
