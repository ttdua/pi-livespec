import { LineCounter, parseDocument } from "yaml";
import { beforeEach, describe, expect, test } from "vitest";
import { validatePackDocument } from "../../src/engine/pack-schema.ts";
import { registerCheck, registerPackSchema, resetRegistryForTests } from "../../src/engine/registry.ts";

const FILE = "flow.yaml";

function validate(text: string, mode: "pack" | "override" = "pack") {
	const lc = new LineCounter();
	const doc = parseDocument(text, { keepSourceTokens: false, lineCounter: lc });
	return validatePackDocument(doc, FILE, lc, mode);
}

function at(errors: ReturnType<typeof validate>) {
	return errors.map((e) => ({ file: e.file, line: e.line, col: e.col }));
}

// Lines 1-8 are the header; the phase starts on line 9.
const HEAD = `name: p
version: 1
content: c
limits: { max_units: 1 }
phases:
  - id: a
    requires: []
    skills: { required: [x] }
`;

function pack(phaseExtra: string): string {
	return `${HEAD}${phaseExtra}`;
}

beforeEach(() => {
	resetRegistryForTests();
	registerCheck("known", async () => []);
});

describe("pack schema", () => {
	test("a valid pack has no errors", () => {
		expect(validate(pack("    checks: [known]\n    gate: self\n    outputs: [specs-diff]\n"))).toEqual([]);
	});

	test("Wrong type", () => {
		const errors = validate(`${HEAD.replace("requires: []", "requires: shape")}`);
		expect(at(errors)).toEqual([{ file: FILE, line: 7, col: 15 }]);
		expect(errors[0]?.message).toContain("list");
	});

	test("Wrong gate value", () => {
		const text = `name: p
version: 1
content: c
phases:
  - id: a
  - id: b
  - id: c
  - id: d
  - id: e
  - id: f
  - id: g
    gate: maybe
`;
		const errors = validate(text);
		expect(at(errors)).toEqual([{ file: FILE, line: 12, col: 11 }]);
		expect(errors[0]?.message).toContain("none");
		expect(errors[0]?.message).toContain("self");
		expect(errors[0]?.message).toContain("human");
	});

	test("Unknown key", () => {
		const errors = validate(pack("    skils: [x]\n"));
		expect(at(errors)).toEqual([{ file: FILE, line: 9, col: 5 }]);
		expect(errors[0]?.message).toContain("skils");
	});

	test("Model key rejected", () => {
		const errors = validate(pack("    model: big\n"));
		expect(at(errors)).toEqual([{ file: FILE, line: 9, col: 5 }]);
		expect(errors[0]?.message).toContain("packs never name models or lane counts (ADR 0005)");
	});

	test("lane keys are rejected at the top level", () => {
		const errors = validate(`lane_count: 3\n${HEAD}`);
		expect(at(errors)).toEqual([{ file: FILE, line: 1, col: 1 }]);
		expect(errors[0]?.message).toContain("ADR 0005");
	});

	test("YAML syntax error", () => {
		const errors = validate("name: p\nphases: [a\n  - b: : :\n");
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]?.line).toBeGreaterThanOrEqual(2);
		expect(errors[0]?.col).toBeGreaterThanOrEqual(1);
		expect(errors[0]?.severity).toBe("error");
	});

	test("Unregistered subagents", () => {
		const errors = validate(pack("    subagents: [{ persona: x }]\n"));
		expect(at(errors)).toEqual([{ file: FILE, line: 9, col: 16 }]);
		expect(errors[0]?.message).toContain("no spec has registered `subagents`");
	});

	test("empty subagents and decisions are accepted without a registration", () => {
		expect(validate(`decisions: {}\n${pack("    subagents: []\n")}`)).toEqual([]);
	});

	test("Registered sub-schema", () => {
		registerPackSchema("decisions", {
			validate(node, report) {
				const map = node as unknown as { items: { key: { value: string } & import("yaml").Node }[] };
				for (const pair of map.items) {
					if (pair.key.value === "x") report(pair.key, "key x is not allowed");
				}
			},
		});
		const errors = validate(`name: p\nversion: 1\ncontent: c\ndecisions:\n  y: 1\n  x: 1\nphases: []\n`);
		expect(at(errors)).toEqual([{ file: FILE, line: 6, col: 3 }]);
		expect(errors[0]?.message).toBe("key x is not allowed");
	});

	test("unknown check names and outputs are reported", () => {
		const errors = validate(pack("    checks: [nope]\n    outputs: [issue#Other]\n"));
		expect(at(errors)).toEqual([
			{ file: FILE, line: 9, col: 14 },
			{ file: FILE, line: 10, col: 15 },
		]);
	});

	test("per other than unit is rejected", () => {
		expect(at(validate(pack("    per: change\n")))).toEqual([{ file: FILE, line: 9, col: 10 }]);
	});

	test("duplicate phase ids are reported at the second id", () => {
		const errors = validate(`${HEAD}  - id: a\n`);
		expect(at(errors)).toEqual([{ file: FILE, line: 9, col: 9 }]);
	});

	test("excluded skills are warnings", () => {
		const errors = validate(pack("    skills: { optional: [context-engineering] }\n").replace("    skills: { required: [x] }\n", ""));
		expect(errors.map((e) => e.severity)).toEqual(["warning"]);
	});

	test("missing required top-level keys are reported", () => {
		const errors = validate("name: p\n");
		expect(errors.map((e) => e.message).join("|")).toContain("version");
	});

	test("override: extends must name a known pack", () => {
		const errors = validate("extends: superpowers\n", "override");
		expect(at(errors)).toEqual([{ file: FILE, line: 1, col: 10 }]);
		expect(errors[0]?.message).toContain("superpowers");
	});

	test("override: name cannot change", () => {
		const errors = validate("extends: agent-skills\nname: mine\n", "override");
		expect(at(errors)).toEqual([{ file: FILE, line: 2, col: 1 }]);
	});

	test("override with non-list phases reports an error", () => {
		const errors = validate("extends: agent-skills\nphases:\n  plan:\n    gate: self\n", "override");
		expect(at(errors)).toEqual([{ file: FILE, line: 3, col: 3 }]);
		expect(errors[0]?.message).toContain("list");
	});

	test("empty override file reports an error", () => {
		const errors = validate("", "override");
		expect(at(errors)).toEqual([{ file: FILE, line: 1, col: 1 }]);
	});

	test("scalar override file reports an error", () => {
		const errors = validate("just text\n", "override");
		expect(at(errors)).toEqual([{ file: FILE, line: 1, col: 1 }]);
	});

	test("override phase may set a partial key set", () => {
		expect(validate("extends: agent-skills\nphases:\n  - id: plan\n    gate: self\n", "override")).toEqual([]);
	});
});
