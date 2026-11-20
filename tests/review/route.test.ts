import { describe, expect, test } from "vitest";
import { normalizeLocation, routeFinding, type RouteFacts } from "../../src/review/route.ts";
import type { Finding } from "../../src/subagents/roles.ts";

const finding = (over: Partial<Finding> = {}): Finding => ({
	severity: "WARNING",
	kind: "defect",
	location: "src/limit.ts:10",
	evidence: "e",
	fix: "f",
	scope: "out-of-scope",
	...over,
});

const facts = (over: Partial<RouteFacts> = {}): RouteFacts => ({
	path: "src/limit.ts",
	units: [
		{ id: "U1", files: ["src/a.ts"] },
		{ id: "U2", files: ["src/limit.ts"] },
	],
	diffFiles: ["src/limit.ts"],
	needsDecision: false,
	...over,
});

describe("routeFinding", () => {
	test("seeded defect routed to its unit", () => {
		expect(routeFinding(finding(), facts())).toEqual({ route: "unit", unit: "U2" });
	});
	test("changed file outside every unit stays in the change", () => {
		expect(routeFinding(finding(), facts({ units: [] }))).toEqual({ route: "in-change" });
	});
	test("untouched file is out of scope", () => {
		expect(routeFinding(finding(), facts({ units: [], diffFiles: [] }))).toEqual({ route: "out-of-scope" });
	});
	test("suggestion is recorded", () => {
		expect(routeFinding(finding({ severity: "SUGGESTION" }), facts())).toEqual({ route: "record" });
	});
	test("missed context outside the diff is in the change", () => {
		const f = finding({ severity: "SUGGESTION", kind: "missed-context" });
		expect(routeFinding(f, facts({ units: [], diffFiles: [], path: "docs/x.md" }))).toEqual({ route: "in-change" });
	});
	test("deleted test file stays in the change", () => {
		const f = finding({ kind: "lowered-standard" });
		expect(routeFinding(f, facts({ units: [], path: "tests/a.test.ts", diffFiles: ["tests/a.test.ts"] }))).toEqual({ route: "in-change" });
	});
	test("old path of a renamed file stays in the change", () => {
		expect(routeFinding(finding(), facts({ units: [], path: "src/old.ts", diffFiles: ["src/new.ts", "src/old.ts"] }))).toEqual({ route: "in-change" });
	});
	test("needsDecision asks a question", () => {
		expect(routeFinding(finding(), facts({ needsDecision: true }))).toEqual({ route: "question" });
	});
	test("a glob in Files matches", () => {
		const r = routeFinding(finding(), facts({ units: [{ id: "U9", files: ["src/**/*.ts"] }] }));
		expect(r).toEqual({ route: "unit", unit: "U9" });
	});
	test("the first unit in body order wins", () => {
		const units = [
			{ id: "U1", files: ["src/**/*.ts"] },
			{ id: "U2", files: ["src/limit.ts"] },
		];
		expect(routeFinding(finding(), facts({ units }))).toEqual({ route: "unit", unit: "U1" });
	});
});

describe("normalizeLocation", () => {
	test("strips ./ and turns backslashes into slashes", () => {
		expect(normalizeLocation("./src\\a.ts")).toEqual({ path: "src/a.ts", line: 1 });
	});
	test("strips a leading slash and keeps the line of path:line:col", () => {
		expect(normalizeLocation("/src/a.ts:3:7")).toEqual({ path: "src/a.ts", line: 3 });
	});
	test("strips any mix of leading ./ and /", () => {
		expect(normalizeLocation("/./src/a.ts:2")).toEqual({ path: "src/a.ts", line: 2 });
	});
	test("keeps the line of path:line", () => {
		expect(normalizeLocation("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12 });
	});
});
