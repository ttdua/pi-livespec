import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TickError, tickChange, tickUnit, untickChange, untickUnit } from "../../src/core/tick.ts";

const change = readFileSync(new URL("../fixtures/change-body.md", import.meta.url), "utf8");
const initiative = readFileSync(new URL("../fixtures/initiative-body.md", import.meta.url), "utf8");

function diffLines(a: string, b: string): number[] {
	const x = a.split("\n");
	const y = b.split("\n");
	expect(y).toHaveLength(x.length);
	return x.flatMap((l, i) => (l === y[i] ? [] : [i]));
}

describe("tick", () => {
	it("tick changes one line", () => {
		const out = tickUnit(change, "U3");
		const d = diffLines(change, out);
		expect(d).toHaveLength(1);
		expect(out.split("\n")[d[0] as number]).toBe("- [x] done");
	});

	it("tick an already done unit", () => {
		expect(() => tickUnit(change, "U1")).toThrow(TickError);
		expect(() => untickUnit(change, "U3")).toThrow(TickError);
	});

	it("malformed status is rejected by tick and untick", () => {
		const doneWithPending = "## Units\n### U1 — a\n- [ ] done\n";
		const pendingWithDone = "## Units\n### U1 — a\n- [x] pending\n";
		expect(() => tickUnit(doneWithPending, "U1")).toThrow(TickError);
		expect(() => untickUnit(pendingWithDone, "U1")).toThrow(TickError);
		expect(() => untickUnit(doneWithPending, "U1")).toThrow(TickError);
		expect(() => tickUnit(pendingWithDone, "U1")).toThrow(TickError);
	});

	it("unknown unit", () => {
		expect(() => tickUnit(change, "U9")).toThrow(TickError);
	});

	it("untick restores bytes", () => {
		expect(untickUnit(tickUnit(change, "U3"), "U3")).toBe(change);
		const crlf = change.replace(/\n/g, "\r\n");
		expect(untickUnit(tickUnit(crlf, "U3"), "U3")).toBe(crlf);
	});

	it("U10 vs U1", () => {
		const body = "## Units\n### U1 — a\n- [ ] pending\n\n### U10 — b\n- [ ] pending";
		const out = tickUnit(body, "U10");
		expect(out).toBe("## Units\n### U1 — a\n- [ ] pending\n\n### U10 — b\n- [x] done");
		expect(tickUnit(body, "U1")).toBe("## Units\n### U1 — a\n- [x] done\n\n### U10 — b\n- [ ] pending");
	});

	it("tick one change line", () => {
		const out = tickChange(initiative, 34);
		const d = diffLines(initiative, out);
		expect(d).toHaveLength(1);
		expect(out.split("\n")[d[0] as number]).toBe("- [x] #34 add-request-context — Depends: —");
		expect(untickChange(out, 34)).toBe(initiative);
		expect(() => tickChange(out, 34)).toThrow(TickError);
	});

	it("missing change", () => {
		expect(() => tickChange(initiative, 99)).toThrow(TickError);
	});
});
