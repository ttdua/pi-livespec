import { beforeEach, describe, expect, test } from "vitest";
import type { Pack } from "../../src/engine/pack-types.ts";
import {
	checkNames,
	getCheck,
	getPackSchema,
	personasForPack,
	registerCheck,
	registerPackSchema,
	resetRegistryForTests,
} from "../../src/engine/registry.ts";

function packWith(decisions: Record<string, unknown>, subagents: unknown[][]): Pack {
	return {
		name: "p",
		version: 1,
		content: "c",
		limits: {},
		loops: {},
		decisions,
		init: { skills: [] },
		phases: subagents.map((s, i) => ({
			id: `ph${i}`,
			requires: [],
			skills: { required: [], optional: [] },
			outputs: [],
			redirects: [],
			checks: [],
			gate: "none" as const,
			subagents: s,
		})),
	};
}

beforeEach(() => resetRegistryForTests());

describe("registry", () => {
	test("registerCheck adds a name", () => {
		const fn = async () => [];
		registerCheck("x-check", fn);
		expect(checkNames()).toEqual(["x-check"]);
		expect(getCheck("x-check")).toBe(fn);
		expect(getCheck("nope")).toBeUndefined();
	});

	test("resetRegistryForTests clears registered checks and schemas", () => {
		registerCheck("x", async () => []);
		registerPackSchema("decisions", { validate() {} });
		resetRegistryForTests();
		expect(checkNames()).toEqual([]);
		expect(getPackSchema("decisions")).toBeUndefined();
	});

	test("registerPackSchema replaces an earlier schema for the same key", () => {
		const a = { validate() {} };
		const b = { validate() {} };
		registerPackSchema("subagents", a);
		registerPackSchema("subagents", b);
		expect(getPackSchema("subagents")).toBe(b);
	});

	test("personasForPack collects personas from decisions and every phase subagents", () => {
		registerPackSchema("decisions", {
			validate() {},
			personas: (v) => (v as { who: string[] }).who,
		});
		registerPackSchema("subagents", {
			validate() {},
			personas: (v) => (v as { persona: string }[]).map((x) => x.persona),
		});
		const pack = packWith({ who: ["zed", "amy"] }, [[{ persona: "bob" }, { persona: "amy" }], [{ persona: "cy" }]]);
		expect(personasForPack(pack)).toEqual(["amy", "bob", "cy", "zed"]);
	});

	test("personasForPack is empty without schemas", () => {
		expect(personasForPack(packWith({ who: ["a"] }, [[{ persona: "b" }]]))).toEqual([]);
	});
});
