import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readVersion } from "../src/version.ts";

const expected = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

describe("readVersion", () => {
	it("returns the version field of package.json", () => {
		expect(readVersion()).toBe(expected);
	});
});
