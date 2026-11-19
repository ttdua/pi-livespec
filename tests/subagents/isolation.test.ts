// Tests for the isolation list: settings reads and known-flow matching.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { configuredPackages, excludedPackages } from "../../src/subagents/isolation.ts";

let root: string;
let home: string;

function settings(base: string, rel: string, text: string): void {
	const file = join(base, rel);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ls-iso-root-"));
	home = mkdtempSync(join(tmpdir(), "ls-iso-home-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

describe("configuredPackages", () => {
	test("reads string and { source } entries from user and project settings", async () => {
		settings(home, ".pi/agent/settings.json", JSON.stringify({ packages: ["git:github.com/obra/superpowers", { source: "npm:acme-flow" }] }));
		settings(root, ".pi/settings.json", JSON.stringify({ packages: ["git:github.com/ttdua/pi-superspec"] }));
		expect(await configuredPackages(root, home)).toEqual([
			"git:github.com/obra/superpowers",
			"npm:acme-flow",
			"git:github.com/ttdua/pi-superspec",
		]);
	});

	test("missing or invalid settings yield no packages", async () => {
		settings(home, ".pi/agent/settings.json", "{not json");
		expect(await configuredPackages(root, home)).toEqual([]);
	});

	test("a non-ENOENT read failure propagates with the path", async () => {
		const file = join(home, ".pi", "agent", "settings.json");
		mkdirSync(file, { recursive: true });
		await expect(configuredPackages(root, home)).rejects.toThrow(file);
	});
});

describe("excludedPackages", () => {
	test("known flows excluded", () => {
		expect(excludedPackages(["git:github.com/obra/superpowers"], [])).toEqual(["git:github.com/obra/superpowers"]);
		expect(excludedPackages(["git:github.com/ttdua/pi-superspec"], [])).toEqual(["git:github.com/ttdua/pi-superspec"]);
	});

	test("unrelated configured packages are not excluded", () => {
		expect(excludedPackages(["npm:unrelated"], [])).toEqual([]);
	});

	test("extra user exclusion only", () => {
		expect(excludedPackages([], ["npm:acme-flow"])).toEqual(["npm:acme-flow"]);
	});

	test("known flow matches with a version suffix, not a longer name", () => {
		expect(excludedPackages(["git:github.com/obra/superpowers@v7"], [])).toEqual(["git:github.com/obra/superpowers@v7"]);
		expect(excludedPackages(["git:github.com/obra/superpowers-extra"], [])).toEqual([]);
	});

	test("no duplicates", () => {
		expect(excludedPackages(["git:github.com/obra/superpowers"], ["git:github.com/obra/superpowers"])).toEqual([
			"git:github.com/obra/superpowers",
		]);
	});
});
