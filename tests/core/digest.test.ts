import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChange, serializeChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { tickUnit } from "../../src/core/tick.ts";

const fixture = readFileSync(new URL("../fixtures/change-body.md", import.meta.url), "utf8");
const digestOf = (text: string, id = "U3") => {
	const u = parseChange(text).units.find((x) => x.id === id);
	if (!u) throw new Error("no unit");
	return unitDigest(u);
};

describe("digest", () => {
	it("stable under reserialization", () => {
		expect(digestOf(serializeChange(parseChange(fixture)))).toBe(digestOf(fixture));
		expect(digestOf(fixture)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("difficulty and tags excluded", () => {
		const a = fixture.replace("Difficulty: medium", "Difficulty: high");
		const b = fixture.replace("Tags: [security, api]", "Tags: [other]");
		expect(digestOf(a)).toBe(digestOf(fixture));
		expect(digestOf(b)).toBe(digestOf(fixture));
	});

	it("status excluded", () => {
		expect(digestOf(tickUnit(fixture, "U3"))).toBe(digestOf(fixture));
	});

	it("contract change alters digest", () => {
		expect(digestOf(fixture.replace("gets 429", "gets 503"))).not.toBe(digestOf(fixture));
		expect(digestOf(fixture.replace("Depends: U1", "Depends: —"))).not.toBe(digestOf(fixture));
		expect(digestOf(fixture.replace("Verify: `npm test -- ratelimit`", "Verify: `npm test -- ratelimit`\nKind: refactor"))).not.toBe(digestOf(fixture));
	});

	it("whitespace normalization", () => {
		const messy = fixture.replace(/\n/g, "  \r\n");
		expect(digestOf(messy)).toBe(digestOf(fixture));
	});
});
