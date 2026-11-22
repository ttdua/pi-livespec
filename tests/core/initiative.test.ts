import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	appendChange,
	initiativeBody,
	insertChangeAfter,
	insertChangeBefore,
	parseInitiative,
	removeChange,
	serializeInitiative,
	setChangeDepends,
} from "../../src/core/initiative.ts";

const fixture = readFileSync(new URL("../fixtures/initiative-body.md", import.meta.url), "utf8");

describe("initiative", () => {
	it("example initiative round trip", () => {
		expect(serializeInitiative(parseInitiative(fixture))).toBe(fixture);
		const crlf = fixture.replace(/\n/g, "\r\n");
		expect(serializeInitiative(parseInitiative(crlf))).toBe(crlf);
	});

	it("change entries", () => {
		const i = parseInitiative(fixture);
		expect(i.goal).toBe("block API abuse without affecting valid clients");
		expect(i.capabilities).toEqual(["rate-limit", "request-context"]);
		expect(i.changes[0]).toMatchObject({ checked: false, number: 34, name: "add-request-context", depends: [] });
		expect(i.changes[1]).toMatchObject({ number: 35, name: "per-ip-cap", depends: [34] });
	});
});

describe("initiative writers", () => {
	const rt = (s: string) => expect(serializeInitiative(parseInitiative(s))).toBe(s);
	it("appendChange", () => {
		const out = appendChange(fixture, { number: 36, name: "audit-log", depends: [35] });
		expect(out).toBe(`${fixture}- [ ] #36 audit-log — Depends: #35\n`);
		rt(out);
	});
	it("appendChange when the last line has no newline", () => {
		const out = appendChange(fixture.trimEnd(), { number: 36, name: "a", depends: [] });
		expect(out).toBe(`${fixture}- [ ] #36 a — Depends: —`);
	});
	it("insertChangeAfter", () => {
		const out = insertChangeAfter(fixture, 34, { number: 36, name: "audit-log", depends: [35] });
		expect(out.split("\n").slice(4, 7)).toEqual([
			"- [ ] #34 add-request-context — Depends: —",
			"- [ ] #36 audit-log — Depends: #35",
			"- [ ] #35 per-ip-cap — Depends: #34",
		]);
		rt(out);
	});
	it("insertChangeBefore", () => {
		const out = insertChangeBefore(fixture, 35, { number: 36, name: "token-store", depends: [] });
		expect(out.split("\n").slice(4, 7)).toEqual([
			"- [ ] #34 add-request-context — Depends: —",
			"- [ ] #36 token-store — Depends: —",
			"- [ ] #35 per-ip-cap — Depends: #34",
		]);
		rt(out);
		expect(insertChangeBefore(fixture, 99, { number: 36, name: "x", depends: [] })).toBe(appendChange(fixture, { number: 36, name: "x", depends: [] }));
	});
	it("setChangeDepends", () => {
		const out = setChangeDepends(fixture, 35, [34, 40]);
		expect(out).toBe(fixture.replace("Depends: #34\n", "Depends: #34, #40\n"));
		expect(parseInitiative(out).changes[1]?.depends).toEqual([34, 40]);
	});
	it("removeChange", () => {
		const out = removeChange(fixture, 34);
		expect(out).toBe(fixture.replace("- [ ] #34 add-request-context — Depends: —\n", ""));
		rt(out);
	});
	it("initiativeBody", () => {
		expect(initiativeBody("g", ["a"])).toBe("Goal: g\nCapabilities: [a]\n\n## Changes\n");
	});
});
