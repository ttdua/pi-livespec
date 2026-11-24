// Tests for the role catalogue: the result schemas each role must submit.
import { describe, expect, test } from "vitest";
import { checkSchema, type JsonSchema, type Role, resultSchema } from "../../src/subagents/roles.ts";

const ROLES: Role[] = ["scout", "implementer", "reviewer", "verifier"];

/** Every node of a schema, depth first, so the subset check covers nested objects and items. */
function nodes(schema: JsonSchema): JsonSchema[] {
	const inner = Object.values(schema.properties ?? {});
	return [schema, ...inner.flatMap(nodes), ...(schema.items ? nodes(schema.items) : [])];
}

describe("resultSchema", () => {
	test("resultSchema(implementer) requires commits", () => {
		const schema = resultSchema("implementer");
		expect(schema.required).toEqual(expect.arrayContaining(["status", "notes", "discoveries", "sources_used", "commits"]));
	});

	test("resultSchema(reviewer) requires findings", () => {
		const schema = resultSchema("reviewer");
		expect(schema.required).toEqual(expect.arrayContaining(["status", "notes", "discoveries", "sources_used", "findings"]));
	});

	test("a reviewer finding without location is rejected and the path is named", () => {
		const finding = { severity: "WARNING", kind: "defect", evidence: "e", fix: "f", scope: "unit" };
		const result = { status: "DONE", notes: "n", discoveries: [], sources_used: [], findings: [finding] };
		const checked = checkSchema(resultSchema("reviewer"), result);
		expect(checked.ok).toBe(false);
		expect(!checked.ok && checked.errors.join("\n")).toContain("$.findings[0].location");
	});

	test("a verifier result without a verdict is invalid, with one it is valid", () => {
		const result = { status: "DONE", notes: "n", discoveries: [], sources_used: [], findings: [] };
		const bad = checkSchema(resultSchema("verifier"), result);
		expect(!bad.ok && bad.errors.join("\n")).toContain("$.verdict is required");
		expect(resultSchema("verifier").required).toContain("verdict");
		expect(checkSchema(resultSchema("verifier"), { ...result, verdict: "refuted" }).ok).toBe(true);
		expect(checkSchema(resultSchema("verifier"), { ...result, verdict: "maybe" }).ok).toBe(false);
		expect(resultSchema("reviewer").required).not.toContain("verdict");
	});

	test("scout requires neither commits nor findings; verifier requires findings", () => {
		expect(resultSchema("scout").required ?? []).not.toContain("commits");
		expect(resultSchema("scout").required ?? []).not.toContain("findings");
		expect(resultSchema("verifier").required).toContain("findings");
	});

	test("scout verdicts accepted", () => {
		const base = { status: "DONE", notes: "", discoveries: [], sources_used: [] };
		const ok = [{ key: "dead-paths:x:src/**", verdict: "refuted", reason: "moved" }];
		expect(checkSchema(resultSchema("scout"), { ...base, verdicts: ok }).ok).toBe(true);
		expect(checkSchema(resultSchema("scout"), { ...base, verdicts: [{ ...ok[0], verdict: "maybe" }] }).ok).toBe(false);
		expect(resultSchema("scout").required ?? []).not.toContain("verdicts");
	});

	test("schemas use only the executor subset", () => {
		const allowed = new Set(["type", "enum", "properties", "items", "required", "additionalProperties"]);
		for (const role of ROLES) {
			for (const node of nodes(resultSchema(role))) {
				for (const key of Object.keys(node)) expect(allowed.has(key)).toBe(true);
			}
		}
	});

	test("every object rejects extra keys", () => {
		for (const role of ROLES) {
			for (const node of nodes(resultSchema(role))) {
				if (node.type === "object") expect(node.additionalProperties).toBe(false);
			}
		}
	});
});
