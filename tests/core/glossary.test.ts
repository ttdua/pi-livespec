import { describe, expect, it } from "vitest";
import { parseGlossary, serializeGlossary } from "../../src/core/glossary.ts";

describe("glossary.test", () => {
	it("entries parsed in order", () => {
		const text = "- **Change**: a unit of work\n- **Unit**: a slice of a change\n";
		const g = parseGlossary(text);
		expect(g.entries).toEqual([
			{ term: "Change", definition: "a unit of work", line: 1 },
			{ term: "Unit", definition: "a slice of a change", line: 2 },
		]);
		expect(serializeGlossary(g)).toBe(text);
	});

	it("other lines preserved", () => {
		const text = "# Glossary\r\n\r\n- **A**: b\r\nstray line";
		const g = parseGlossary(text);
		expect(g.entries).toHaveLength(1);
		expect(g.entries[0]?.line).toBe(3);
		expect(serializeGlossary(g)).toBe(text);
	});
});
