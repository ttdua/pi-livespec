import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { checkDoneMapsScenarios, validateUnits } from "../../src/core/validate-units.ts";

const fixture = readFileSync("tests/fixtures/change-body.md", "utf8");
const U3 = fixture.slice(fixture.indexOf("### U3"), fixture.indexOf("## Durable docs"));
const U1 = fixture.slice(fixture.indexOf("### U1"), fixture.indexOf("### U3"));
const wrap = (units: string) => `Base: abc\n\n## Units\n${U1}${units}\n## Durable docs\n`;
const units = (text: string) => validateUnits(parseChange(wrap(text)));
const codes = (r: { code: string }[]) => r.map((x) => x.code);
const u3 = (from: string, to: string) => {
	if (!U3.includes(from)) throw new Error(`fixture lacks ${from}`);
	return U3.replace(from, to);
};

describe("validate-units.test", () => {
	it("example units valid", () => {
		const c = parseChange(fixture);
		expect(validateUnits(c)).toEqual([]);
		expect(checkDoneMapsScenarios(c)).toEqual([]);
	});

	it("missing field", () => {
		const r = units(u3("Files: src/middleware/ratelimit.ts, test/ratelimit.test.ts\n", ""));
		expect(codes(r)).toEqual(["units-format"]);
		expect(r[0]?.message).toContain("Files");
	});

	it("missing Tags and Covers", () => {
		const r = units(u3("Tags: [security, api]\n", "").replace(/Covers:.*\n/, ""));
		expect(r).toHaveLength(2);
	});

	it("bad difficulty", () => {
		const r = units(u3("Difficulty: medium", "Difficulty: hard"));
		expect(codes(r)).toEqual(["units-format"]);
		expect(r[0]?.message).toContain("Difficulty");
	});

	it("two verify commands", () => {
		const r = units(u3("Verify: `npm test -- ratelimit`", "Verify: `npm test` `npm run lint`"));
		expect(codes(r)).toEqual(["units-format"]);
	});

	it("verify without backticks", () => {
		expect(codes(units(u3("Verify: `npm test -- ratelimit`", "Verify: npm test")))).toEqual(["units-format"]);
	});

	it("malformed status", () => {
		expect(codes(units(u3("- [ ] pending", "- [ ] todo")))).toEqual(["units-format"]);
		expect(codes(units(u3("- [ ] pending", "- [x] pending")))).toEqual(["units-format"]);
	});

	it("done item without label", () => {
		const r = units(u3("- [cap] the 101st", "- the 101st"));
		expect(r.some((x) => x.code === "units-format")).toBe(true);
	});

	it("duplicate unit id", () => {
		const r = units(`${U3}\n${U3}`);
		expect(codes(r)).toEqual(["units-format"]);
		expect(r[0]?.message).toContain("U3");
	});

	it("depends on missing unit", () => {
		const r = units(u3("Depends: U1", "Depends: U9"));
		expect(codes(r)).toEqual(["units-format"]);
		expect(r[0]?.message).toContain("U9");
	});

	it("done item without scenario", () => {
		const c = parseChange(wrap(u3("- [cap] test/ratelimit.test.ts › rejects 101st request\n", "")));
		const r = checkDoneMapsScenarios(c);
		expect(codes(r)).toEqual(["done-maps-scenarios"]);
		expect(r[0]?.message).toContain("cap");
	});

	it("scenario without done item", () => {
		const c = parseChange(wrap(u3("- [cap] test/ratelimit", "- [x] test/ratelimit")));
		const r = checkDoneMapsScenarios(c);
		expect(codes(r)).toEqual(["done-maps-scenarios", "done-maps-scenarios"]);
	});

	it("labels match", () => {
		expect(checkDoneMapsScenarios(parseChange(wrap(U3)))).toEqual([]);
	});
});
