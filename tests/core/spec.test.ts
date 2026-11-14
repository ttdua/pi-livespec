import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSpec, serializeSpec } from "../../src/core/spec.ts";

const fixture = readFileSync(new URL("../fixtures/rate-limit.spec.md", import.meta.url), "utf8");

describe("spec", () => {
	it("living spec round trip", () => {
		expect(serializeSpec(parseSpec(fixture, "rate-limit"))).toBe(fixture);
	});

	it("unknown section preserved", () => {
		const text = `${fixture}\n## Notes\nFree *text* here.\n`;
		const spec = parseSpec(text, "rate-limit");
		expect(serializeSpec(spec)).toBe(text);
		expect(spec.requirements).toHaveLength(1);
	});

	it("CRLF preserved", () => {
		const text = fixture.replace(/\n/g, "\r\n");
		const spec = parseSpec(text, "rate-limit");
		expect(serializeSpec(spec)).toBe(text);
		expect(spec.lines.every((l) => l.eol === "\r\n")).toBe(true);
		expect(spec.requirements[0]?.name).toBe("Per-IP cap");
		expect(spec.requirements[0]?.scenarios[0]?.when).toHaveLength(1);
	});

	it("requirements and scenarios extracted", () => {
		const spec = parseSpec(fixture, "rate-limit");
		expect(spec.capability).toBe("rate-limit");
		expect(spec.purpose).toBe("Why this capability exists, in one or two sentences.");
		expect(spec.requirements).toHaveLength(1);
		const req = spec.requirements[0];
		expect(req?.name).toBe("Per-IP cap");
		expect(req?.text).toContain("SHALL reject a request");
		expect(req?.scenarios).toHaveLength(1);
		const sc = req?.scenarios[0];
		expect(sc?.name).toBe("rejects 101st request");
		expect(sc?.when).toEqual(["one IP sends its 101st request within 60 seconds"]);
		expect(sc?.then).toEqual(["the response status is 429"]);
	});

	it("paths read from front matter", () => {
		expect(parseSpec(fixture, "rate-limit").paths).toEqual([
			"src/middleware/ratelimit.ts",
			"src/limits/**",
		]);
	});

	it("no front matter", () => {
		const body = fixture.split("\n").slice(3).join("\n");
		const spec = parseSpec(body, "rate-limit");
		expect(spec.paths).toEqual([]);
		expect(spec.requirements).toHaveLength(1);
	});

	it("fenced requirement header is not structure", () => {
		const text = [
			"## Requirements",
			"### Requirement: Real",
			"The system SHALL do x.",
			"",
			"```markdown",
			"### Requirement: Example only",
			"#### Scenario: fake",
			"- **WHEN** fake",
			"- **THEN** fake",
			"```",
			"",
			"#### Scenario: real",
			"- **WHEN** a",
			"- **THEN** b",
			"",
		].join("\n");
		const spec = parseSpec(text, "x");
		expect(serializeSpec(spec)).toBe(text);
		expect(spec.requirements.map((r) => r.name)).toEqual(["Real"]);
		expect(spec.requirements[0]?.scenarios.map((s) => s.name)).toEqual(["real"]);
		expect(spec.requirements[0]?.text).toContain("### Requirement: Example only");
	});

	it("fenced level-2 heading does not end Requirements", () => {
		const text = [
			"## Requirements",
			"### Requirement: Real",
			"~~~",
			"## Notes",
			"~~~",
			"#### Scenario: real",
			"- **WHEN** a",
			"- **THEN** b",
			"",
		].join("\n");
		const spec = parseSpec(text, "x");
		expect(serializeSpec(spec)).toBe(text);
		expect(spec.requirements[0]?.scenarios).toHaveLength(1);
		expect(spec.requirements[0]?.scenarios[0]?.then).toEqual(["b"]);
	});

	it("fence closes only on matching char and length", () => {
		const text = [
			"## Requirements",
			"### Requirement: Real",
			"````",
			"~~~",
			"```",
			"### Requirement: Fake",
			"````",
			"#### Scenario: real",
			"- **WHEN** a",
			"- **THEN** b",
			"",
		].join("\n");
		const spec = parseSpec(text, "x");
		expect(spec.requirements.map((r) => r.name)).toEqual(["Real"]);
		expect(spec.requirements[0]?.scenarios.map((s) => s.name)).toEqual(["real"]);
	});

	it("empty input", () => {
		const spec = parseSpec("", "x");
		expect(spec.requirements).toEqual([]);
		expect(spec.purpose).toBe("");
		expect(serializeSpec(spec)).toBe("");
	});

	it("spec without Requirements section", () => {
		const text = "## Purpose\nOnly a purpose.\n";
		const spec = parseSpec(text, "x");
		expect(spec.purpose).toBe("Only a purpose.");
		expect(spec.requirements).toEqual([]);
		expect(serializeSpec(spec)).toBe(text);
	});

	it("last scenario without trailing newline", () => {
		const text = fixture.trimEnd();
		const spec = parseSpec(text, "x");
		expect(serializeSpec(spec)).toBe(text);
		expect(spec.requirements[0]?.scenarios[0]?.then).toHaveLength(1);
	});
});
