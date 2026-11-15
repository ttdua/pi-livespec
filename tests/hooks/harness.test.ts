// The hook test repos carry a forge-shaped origin URL that is only parsed for
// host, owner and repo. Git must refuse to reach it, so no test touches the network.

import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupHomes, harness } from "./helpers.ts";

afterEach(cleanupHomes);

describe("hook test repos", () => {
	test("git fetch origin is refused before any network attempt", async () => {
		const h = await harness();
		const started = Date.now();
		const r = spawnSync("git", ["fetch", "origin"], { cwd: h.root, encoding: "utf8", timeout: 10_000 });
		expect(r.status).not.toBe(0);
		expect(r.stderr).toMatch(/transport 'https' not allowed/);
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});
