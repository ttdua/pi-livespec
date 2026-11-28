import { afterEach, describe, expect, test } from "vitest";
import { setSession } from "../../src/hooks/session-store.ts";
import { cleanupDirs, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const DECISION_TOOLS = ["spec_gate", "plan_units", "unit_amend", "spec_question", "spec_stuck", "initiative_propose", "new_dependency"];
const FORBIDDEN = ["outcome", "choice", "answer", "approved", "difficulty", "tags"];

/** Every property name declared anywhere in a JSON schema: `properties`, `items`, combinators and nested objects. */
function propertyNames(schema: unknown): string[] {
	if (Array.isArray(schema)) return schema.flatMap(propertyNames);
	if (schema === null || typeof schema !== "object") return [];
	const names: string[] = [];
	for (const [key, value] of Object.entries(schema)) {
		if (key === "properties" && value !== null && typeof value === "object") {
			for (const [name, sub] of Object.entries(value)) names.push(name, ...propertyNames(sub));
		} else {
			names.push(...propertyNames(value));
		}
	}
	return names;
}

/** Dotted paths of every declared property (`items` and combinators add no segment), e.g. `behavior.outcome`. */
function propertyPaths(schema: unknown, prefix = ""): string[] {
	if (Array.isArray(schema)) return schema.flatMap((s) => propertyPaths(s, prefix));
	if (schema === null || typeof schema !== "object") return [];
	const paths: string[] = [];
	for (const [key, value] of Object.entries(schema)) {
		if (key === "properties" && value !== null && typeof value === "object") {
			for (const [name, sub] of Object.entries(value)) {
				const path = prefix === "" ? name : `${prefix}.${name}`;
				paths.push(path, ...propertyPaths(sub, path));
			}
		} else {
			paths.push(...propertyPaths(value, prefix));
		}
	}
	return paths;
}

/** `spec_gate`'s `behavior[].outcome` is the agent's conclusion about code, not an answer to the gate; only that path is exempt. */
const ALLOWED_PATHS = new Set(["spec_gate:behavior.outcome"]);

describe("approver-adapters", () => {
	test("Tool has no answer parameter", async () => {
		const h = await toolHarness();
		for (const name of DECISION_TOOLS) {
			const tool = h.pi.tools.get(name);
			expect(tool, name).toBeDefined();
			const names = propertyNames(tool?.parameters);
			expect(names.length, `${name} declares parameters`).toBeGreaterThan(0);
			expect(propertyPaths(tool?.parameters).filter((p) => FORBIDDEN.includes((p.split(".").pop() ?? "").toLowerCase()) && !ALLOWED_PATHS.has(`${name}:${p}`)), name).toEqual([]);
		}
	});

	test("only the behavior path is exempt", () => {
		const schema = { type: "object", properties: { outcome: {}, behavior: { type: "array", items: { type: "object", properties: { outcome: {} } } } } };
		expect(propertyPaths(schema)).toEqual(["outcome", "behavior", "behavior.outcome"]);
	});

	test("the walker sees nested properties", () => {
		const schema = { type: "object", properties: { units: { type: "array", items: { type: "object", properties: { tags: {} } } } } };
		expect(propertyNames(schema)).toEqual(["units", "tags"]);
	});
});
