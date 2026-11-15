import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import {
	type RenderableUnit,
	insertUnitBlock,
	removeUnitBlock,
	renderUnit,
	replaceUnitBlock,
	setUnitField,
} from "../../src/core/unit-blocks.ts";

const body = readFileSync(new URL("../fixtures/change-body.md", import.meta.url), "utf8");
const crlf = body.replace(/\n/g, "\r\n");

const unit: RenderableUnit = {
	id: "U2",
	title: "Burst allowance",
	covers: ["rate-limit/Requirement: Burst", "rate-limit/Requirement: Per-IP cap"],
	difficulty: "high",
	tags: ["api", "perf"],
	files: ["src/burst.ts", "test/burst.test.ts"],
	done_means: [{ label: "b", text: "bursts up to 10 are allowed" }],
	scenarios: [{ label: "b", ref: "test/burst.test.ts › allows burst" }],
	depends: ["U1"],
	verify: "npm test -- burst",
};

describe("unit blocks", () => {
	it("rendered unit parses back with the same fields", () => {
		const out = insertUnitBlock(body, renderUnit({ ...unit, kind: "refactor" }));
		const u = parseChange(out).units.find((x) => x.id === "U2");
		expect(u).toMatchObject({
			title: unit.title,
			covers: unit.covers,
			difficulty: "high",
			tags: ["api", "perf"],
			files: unit.files,
			doneMeans: unit.done_means,
			scenarios: unit.scenarios,
			depends: ["U1"],
			verify: unit.verify,
			kind: "refactor",
			done: false,
		});
	});

	it("renders an empty depends list as a dash and no Kind line", () => {
		const lines = renderUnit({ ...unit, depends: [], tags: [] });
		expect(lines).toContain("Depends: —");
		expect(lines).toContain("Tags: []");
		expect(lines.some((l) => l.startsWith("Kind:"))).toBe(false);
		expect(lines.at(-1)).toBe("- [ ] pending");
	});

	it("replace keeps every other line byte-identical", () => {
		const out = replaceUnitBlock(body, "U3", renderUnit({ ...unit, id: "U3" }));
		const before = parseChange(body);
		const after = parseChange(out);
		const u = before.units[1]!;
		const head = before.lines.slice(0, u.startLine).map((l) => l.text + l.eol);
		const tail = before.lines.slice(u.endLine + 1).map((l) => l.text + l.eol);
		expect(out.startsWith(head.join(""))).toBe(true);
		expect(out.endsWith(tail.join(""))).toBe(true);
		expect(after.units[1]!.title).toBe("Burst allowance");
	});

	it("unit block replace keeps CRLF endings", () => {
		const out = replaceUnitBlock(crlf, "U1", renderUnit({ ...unit, id: "U1" }));
		expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
		expect(out.split("\n").every((l, i, a) => i === a.length - 1 || l.endsWith("\r"))).toBe(true);
	});

	it("insert appends after the last unit", () => {
		const out = insertUnitBlock(body, renderUnit(unit));
		const c = parseChange(out);
		expect(c.units.map((u) => u.id)).toEqual(["U1", "U3", "U2"]);
		expect(out).toContain("- [ ] pending\n\n## Durable docs");
		const crlfOut = insertUnitBlock(crlf, renderUnit(unit));
		expect(crlfOut.split("\n").every((l, i, a) => i === a.length - 1 || l.endsWith("\r"))).toBe(true);
	});

	it("remove keeps other blocks", () => {
		const out = removeUnitBlock(body, "U1");
		const c = parseChange(out);
		expect(c.units.map((u) => u.id)).toEqual(["U3"]);
		expect(out).toContain("## Units\n### U3");
		const last = removeUnitBlock(body, "U3");
		expect(parseChange(last).units.map((u) => u.id)).toEqual(["U1"]);
		expect(last).toContain("- [x] done\n\n## Durable docs");
	});

	it("setUnitField changes one line", () => {
		const out = setUnitField(body, "U3", "Difficulty", "high");
		const a = body.split("\n");
		const b = out.split("\n");
		expect(b).toHaveLength(a.length);
		const diff = a.flatMap((l, i) => (l === b[i] ? [] : [i]));
		expect(diff).toHaveLength(1);
		expect(b[diff[0]!]).toBe("Difficulty: high");
		expect(setUnitField(crlf, "U3", "Tags", "[a]")).toContain("Tags: [a]\r\n");
	});
});
