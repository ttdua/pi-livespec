import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

describe("package manifest", () => {
	it("names real extension entry points", () => {
		expect(pkg.pi.extensions.length).toBeGreaterThan(0);
		for (const entry of pkg.pi.extensions as string[]) {
			expect(existsSync(new URL(entry, root)), entry).toBe(true);
		}
	});

	it("declares the pi peer dependency with range *", () => {
		expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("*");
	});

	it("has yaml as the only runtime dependency", () => {
		expect(Object.keys(pkg.dependencies)).toEqual(["yaml"]);
	});
});

describe("CI workflow", () => {
	const path = new URL(".github/workflows/ci.yml", root);

	it("triggers on push and pull_request and runs typecheck and test", () => {
		const text = readFileSync(path, "utf8");
		expect(text).toMatch(/^\s*push:/m);
		expect(text).toMatch(/^\s*pull_request:/m);
		expect(text).toContain("bun run typecheck");
		expect(text).toContain("bun run test");
	});
});
