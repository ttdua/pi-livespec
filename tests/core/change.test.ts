import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChange, serializeChange } from "../../src/core/change.ts";

const fixture = readFileSync(new URL("../fixtures/change-body.md", import.meta.url), "utf8");

describe("change", () => {
	it("example body round trip", () => {
		expect(serializeChange(parseChange(fixture))).toBe(fixture);
	});

	it("round trips CRLF, empty and unterminated last unit", () => {
		const crlf = fixture.replace(/\n/g, "\r\n");
		expect(serializeChange(parseChange(crlf))).toBe(crlf);
		expect(serializeChange(parseChange(""))).toBe("");
		const cut = fixture.slice(0, fixture.indexOf("\n## Durable docs")).trimEnd();
		const c = parseChange(cut);
		expect(serializeChange(c)).toBe(cut);
		expect(c.units[1]?.done).toBe(false);
		expect(c.units[1]?.statusLine).toBe(c.lines.length - 1);
	});

	it("optional ownership lines", () => {
		const c = parseChange("Base: abc\nBranch: livespec/x\nCapabilities: new [], modified []\n\n## Units\n");
		expect(c.header.initiative).toBeUndefined();
		expect(c.header.depends).toBeUndefined();
		expect(c.header.pr).toBeUndefined();
		expect(c.header.base).toBe("abc");
		const full = parseChange(fixture);
		expect(full.header.initiative).toBe("#12");
		expect(full.header.depends).toEqual(["#34"]);
		expect(full.header.pr).toBe("#41");
		expect(full.header.branch).toBe("livespec/per-ip-cap");
		expect(full.header.productImpact).toBe("none — internal limit only");
	});

	it("capabilities line", () => {
		expect(parseChange(fixture).header.capabilities).toEqual({ new: [], modified: ["rate-limit"] });
	});

	it("unknown section kept", () => {
		const text = `${fixture}\n## Notes\nFree text.\n`;
		const c = parseChange(text);
		expect(serializeChange(c)).toBe(text);
		expect(c.units).toHaveLength(2);
		expect(c.durableDocs).toHaveLength(5);
		expect(c.durableDocs[0]).toEqual({ file: "specs/<capability>/spec.md", status: "updated" });
	});

	it("open and answered questions", () => {
		const [q1, q2] = parseChange(fixture).questions;
		expect(q1).toMatchObject({ id: "Q1", kind: "blocking", checked: false });
		expect(q1?.answer).toBeUndefined();
		expect(q2).toMatchObject({ id: "Q2", kind: "non-blocking", checked: true, answer: "yes" });
		expect(q2?.text).toBe("Should the window be configurable?");
	});

	it("example unit fields", () => {
		const u = parseChange(fixture).units.find((x) => x.id === "U3");
		expect(u).toMatchObject({
			title: "Rate limit per IP",
			covers: ["rate-limit/Requirement: Per-IP cap"],
			difficulty: "medium",
			tags: ["security", "api"],
			files: ["src/middleware/ratelimit.ts", "test/ratelimit.test.ts"],
			depends: ["U1"],
			verify: "npm test -- ratelimit",
			done: false,
		});
		expect(u?.doneMeans).toEqual([{ label: "cap", text: "the 101st request within 60 s from one IP gets 429" }]);
		expect(u?.scenarios).toEqual([{ label: "cap", ref: "test/ratelimit.test.ts › rejects 101st request" }]);
	});

	it("depends dash", () => {
		const u = parseChange(fixture).units.find((x) => x.id === "U1");
		expect(u?.depends).toEqual([]);
		expect(u?.done).toBe(true);
		expect(u?.tags).toEqual([]);
	});

	it("kind refactor", () => {
		const text = fixture.replace("Verify: `npm test -- ratelimit`\n", "Verify: `npm test -- ratelimit`\nKind: refactor\n");
		expect(parseChange(text).units[1]?.kind).toBe("refactor");
	});

	it("tolerates missing fields", () => {
		const c = parseChange("## Units\n### U10 — Bare\nCovers: a/Requirement: b\n");
		const u = c.units[0];
		expect(u?.id).toBe("U10");
		expect(u?.files).toEqual([]);
		expect(u?.verify).toBeUndefined();
		expect(u?.difficulty).toBeUndefined();
		expect(u?.statusLine).toBe(-1);
	});
});
