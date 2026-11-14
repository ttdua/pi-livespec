import { describe, expect, it } from "vitest";
import * as barrel from "../../src/forge/index.ts";
import type { CachedForgeOptions, DetectDeps, ExecFn, ExecResult, GiteaOptions, GitHubForgeOptions } from "../../src/forge/index.ts";

// Type-level: typecheck fails if any option type is missing from the barrel.
type Exported = [GitHubForgeOptions, GiteaOptions, CachedForgeOptions, DetectDeps, ExecFn, ExecResult];
const keys: Array<keyof Exported> = [0, 1, 2, 3, 4, 5];

describe("forge barrel", () => {
	it("exports the option types and the runtime classes", () => {
		expect(keys).toHaveLength(6);
		for (const name of ["GitHubForge", "GiteaForge", "CachedForge", "detectForge"]) {
			expect(typeof (barrel as Record<string, unknown>)[name]).toBe("function");
		}
	});
});
