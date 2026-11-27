import { describe, expect, it } from "vitest";
import { type LedgerEntry, entryVersion, fileFor, newRef } from "../../src/ledger/entry.ts";

const entry: LedgerEntry = {
	ref: "progress.U1~0123abcd",
	kind: "decision",
	id: "progress.U1",
	seq: 1,
	at: "2026-11-27T10:00:00.000Z",
	data: { point: "progress", subject: "U1", nested: { b: 2, a: 1 } },
};

describe("newRef", () => {
	it("appends eight lowercase hex characters to the id", () => {
		expect(newRef("progress.U1")).toMatch(/^progress\.U1~[0-9a-f]{8}$/);
	});

	it("never repeats for the same id", () => {
		expect(newRef("progress.U1")).not.toBe(newRef("progress.U1"));
	});
});

describe("entryVersion", () => {
	it("ignores seq", () => {
		expect(entryVersion({ ...entry, seq: 7 })).toBe(entryVersion(entry));
	});

	it("ignores data key order", () => {
		const reordered = { ...entry, data: { nested: { a: 1, b: 2 }, subject: "U1", point: "progress" } };
		expect(entryVersion(reordered)).toBe(entryVersion(entry));
	});

	it("changes when data changes", () => {
		expect(entryVersion({ ...entry, data: { point: "progress", subject: "U2" } })).not.toBe(entryVersion(entry));
	});

	it("is a sha256 hex digest", () => {
		expect(entryVersion(entry)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("fileFor", () => {
	it("puts unit records in the unit file", () => {
		expect(fileFor("receipt", { unit: "U2" })).toBe("units/U2.yaml");
		expect(fileFor("unit-start", { unit: "U2" })).toBe("units/U2.yaml");
	});

	it("puts counters in change.yaml", () => {
		expect(fileFor("counter", {})).toBe("change.yaml");
	});

	it("puts JSONL kinds in their files", () => {
		expect(fileFor("finding-summary", {})).toBe("findings.jsonl");
		expect(fileFor("decision", {})).toBe("decisions.jsonl");
		expect(fileFor("dispatch", {})).toBe("dispatch.jsonl");
	});

	it("refuses a unit record without a safe unit name", () => {
		expect(() => fileFor("receipt", {})).toThrow();
		expect(() => fileFor("receipt", { unit: "../x" })).toThrow();
	});
});
