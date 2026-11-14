import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGlossary } from "../../src/core/glossary.ts";
import { parseSpec } from "../../src/core/spec.ts";
import { validateGlossary, validateSpec } from "../../src/core/validate-spec.ts";

const valid = readFileSync("tests/fixtures/rate-limit.spec.md", "utf8");
const run = (text: string) => validateSpec(parseSpec(text, "rate-limit"), "specs/rate-limit/spec.md");
const body = (req: string) => `# x\n\n## Requirements\n\n${req}`;

describe("validate-spec.test", () => {
	it("result shape", () => {
		const r = run(body("### Requirement: A\nNothing normative.\n\n#### Scenario: s\n- **WHEN** a\n- **THEN** b\n"));
		expect(r).toHaveLength(1);
		expect(r[0]).toMatchObject({
			code: "spec-normative",
			severity: "error",
			file: "specs/rate-limit/spec.md",
			line: 5,
		});
		expect(typeof r[0]?.message).toBe("string");
	});

	it("missing normative word", () => {
		const r = run(body("### Requirement: A\nIt does things.\n\n#### Scenario: s\n- **WHEN** a\n- **THEN** b\n"));
		expect(r.map((x) => x.code)).toEqual(["spec-normative"]);
	});

	it("SHALL only inside a scenario does not count", () => {
		const r = run(body("### Requirement: A\nIt does things.\n\n#### Scenario: s\n- **WHEN** a\n- **THEN** b SHALL c\n"));
		expect(r.map((x) => x.code)).toEqual(["spec-normative"]);
	});

	it("MUST is accepted", () => {
		const r = run(body("### Requirement: A\nIt MUST do.\n\n#### Scenario: s\n- **WHEN** a\n- **THEN** b\n"));
		expect(r).toEqual([]);
	});

	it("requirement without scenario", () => {
		const r = run(body("### Requirement: A\nIt SHALL do.\n"));
		expect(r.map((x) => x.code)).toEqual(["spec-scenario-missing"]);
	});

	it("scenario missing THEN", () => {
		const r = run(body("### Requirement: A\nIt SHALL do.\n\n#### Scenario: s\n- **WHEN** a\n"));
		expect(r.map((x) => x.code)).toEqual(["spec-when-then"]);
		expect(r[0]?.line).toBe(8);
	});

	it("scenario missing WHEN", () => {
		const r = run(body("### Requirement: A\nIt SHALL do.\n\n#### Scenario: s\n- **THEN** a\n"));
		expect(r.map((x) => x.code)).toEqual(["spec-when-then"]);
	});

	it("duplicate requirement name", () => {
		const one = "### Requirement: A\nIt SHALL do.\n\n#### Scenario: s\n- **WHEN** a\n- **THEN** b\n\n";
		const r = run(body(one + one));
		expect(r.map((x) => x.code)).toEqual(["spec-duplicate-requirement"]);
	});

	it("invalid paths glob", () => {
		const r = run(valid.replace('"src/limits/**"', '"src/{a,b"'));
		expect(r.map((x) => x.code)).toEqual(["spec-paths-glob"]);
	});

	it("valid spec", () => {
		expect(run(valid)).toEqual([]);
	});
});

describe("validate-glossary.test", () => {
	const g = (text: string) => validateGlossary(parseGlossary(text), "specs/glossary.md");

	it("unsorted terms", () => {
		const r = g("- **Unit**: a\n- **Change**: b\n");
		expect(r.map((x) => x.code)).toEqual(["glossary-order"]);
		expect(r[0]?.line).toBe(2);
	});

	it("duplicate term", () => {
		const r = g("- **Change**: a\n- **Change**: b\n");
		expect(r.map((x) => x.code)).toEqual(["glossary-duplicate"]);
	});

	it("sorted glossary is clean", () => {
		expect(g("# Glossary\n\n- **Change**: a\n- **unit**: b\n")).toEqual([]);
	});
});
