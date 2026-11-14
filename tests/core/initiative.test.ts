import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseInitiative, serializeInitiative } from "../../src/core/initiative.ts";

const fixture = readFileSync(new URL("../fixtures/initiative-body.md", import.meta.url), "utf8");

describe("initiative", () => {
	it("example initiative round trip", () => {
		expect(serializeInitiative(parseInitiative(fixture))).toBe(fixture);
		const crlf = fixture.replace(/\n/g, "\r\n");
		expect(serializeInitiative(parseInitiative(crlf))).toBe(crlf);
	});

	it("change entries", () => {
		const i = parseInitiative(fixture);
		expect(i.goal).toBe("block API abuse without affecting valid clients");
		expect(i.capabilities).toEqual(["rate-limit", "request-context"]);
		expect(i.changes[0]).toMatchObject({ checked: false, number: 34, name: "add-request-context", depends: [] });
		expect(i.changes[1]).toMatchObject({ number: 35, name: "per-ip-cap", depends: [34] });
	});
});
