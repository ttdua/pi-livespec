import { describe, expect, test } from "vitest";
import { type ReceiptData, type StartData, asRebuildRecord, newEvidenceId, readReceipts, readStarts, receiptComment, startComment } from "../../src/evidence/records.ts";
import type { MarkedComment } from "../../src/forge/markers.ts";
import { ledgerRecord } from "../helpers/ledger.ts";

const start: StartData = {
	unit: "U1",
	digest: "d1",
	verify: "bun test a",
	pre: { sha: "a".repeat(40), exit: 1, verdict: "red", output: "FAIL a\n" },
};
const receipt: ReceiptData = {
	unit: "U1",
	digest: "d1",
	verify: "bun test a",
	pre: { sha: "a".repeat(40), exit: 1 },
	post: { sha: "b".repeat(40), exit: 0 },
	output: "ok\n",
	start: "U1.abc",
};


describe("evidence records", () => {
	test("unit-start round trip", () => {
		expect(startComment("U1.abc", start)).toEqual({ kind: "unit-start", id: "U1.abc", data: start });
	});

	test("receipt round trip", () => {
		expect(receiptComment("U1.abd", receipt)).toEqual({ kind: "receipt", id: "U1.abd", data: receipt });
	});

	test("newEvidenceId", () => {
		expect(newEvidenceId("U1", new Date())).toMatch(/^U1\.[0-9a-z]+$/);
		expect(newEvidenceId("U1", new Date(36))).toBe("U1.10");
	});

	test("readStarts and readReceipts keep comment order and skip malformed records", () => {
		const marked = [
			ledgerRecord(startComment("U1.a", start), { ref: "c1" }),
			{ ref: "c2", source: "ledger" as const, author: "bot", kind: "unit-start", id: "U1.b", data: { unit: "U1" } },
			ledgerRecord(receiptComment("U1.c", receipt), { ref: "c3" }),
			{ ref: "c4", source: "ledger" as const, author: "bot", kind: "receipt", id: "U2.d", data: { ...receipt, post: "x" } },
		];
		expect(readStarts(marked)).toEqual([{ ...start, id: "U1.a", commentId: "c1", index: 0 }]);
		expect(readReceipts(marked)).toEqual([{ ...receipt, id: "U1.c", commentId: "c3", index: 2 }]);
	});

	test("rebuild reader rejects a malformed record", () => {
		const ok: MarkedComment = { source: "forge", ref: "c1", author: "bot", kind: "rebuild", id: "rebuild.U1.1", data: { unit: "U1", round: 1, finding: "c:0" } };
		expect(asRebuildRecord(ok, 3)).toMatchObject({ unit: "U1", round: 1, index: 3 });
		expect(asRebuildRecord({ ...ok, data: { unit: "U1", round: "1", finding: "c:0" } }, 0)).toBeUndefined();
	});
});
