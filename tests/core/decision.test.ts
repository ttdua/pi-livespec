import { describe, expect, it } from "vitest";
import { parseDecision, serializeDecision } from "../../src/core/decision.ts";

describe("decision.test", () => {
	it("superseded decision", () => {
		const text = "---\nstatus: superseded\nsuperseded_by: 5\n---\n# Title\r\n";
		const d = parseDecision("specs/decisions/0002-x.md", text);
		expect(d.number).toBe(2);
		expect(d.slug).toBe("x");
		expect(d.status).toBe("superseded");
		expect(d.supersededBy).toBe(5);
		expect(serializeDecision(d)).toBe(text);
	});

	it("optional fields absent", () => {
		const d = parseDecision("0001-first-one.md", "---\nstatus: accepted\n---\nbody\n");
		expect(d.slug).toBe("first-one");
		expect(d.spine).toBe(false);
		expect(d.capabilities).toEqual([]);
		expect(d.supersededBy).toBeUndefined();
	});

	it("spine and capabilities read", () => {
		const d = parseDecision("0010-y.md", "---\nstatus: accepted\nspine: true\ncapabilities: [a, b]\n---\n");
		expect(d.number).toBe(10);
		expect(d.spine).toBe(true);
		expect(d.capabilities).toEqual(["a", "b"]);
	});
});
