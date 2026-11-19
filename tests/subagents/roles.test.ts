import { describe, expect, test } from "vitest";
import { type JsonSchema, type Role, resultSchema } from "../../src/subagents/roles.ts";

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

	test("scout requires neither commits nor findings; verifier requires findings", () => {
		expect(resultSchema("scout").required ?? []).not.toContain("commits");
		expect(resultSchema("scout").required ?? []).not.toContain("findings");
		expect(resultSchema("verifier").required).toContain("findings");
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
