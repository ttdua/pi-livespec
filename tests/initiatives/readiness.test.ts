import { describe, expect, it } from "vitest";
import { isReady, readDependencies } from "../../src/initiatives/readiness.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";

describe("readiness", () => {
	it("waits on an open change", async () => {
		const w = new MemoryWorld();
		const n = await w.seedIssue({ title: "t" });
		const facts = await readDependencies(w.forge, [n]);
		expect(facts).toEqual([{ number: n, title: "t", state: "open" }]);
		expect(isReady(facts)).toBe(false);
	});
	it("is ready after merge", async () => {
		const w = new MemoryWorld();
		const pr = await w.seedPullRequest({ head: "h", merged: true, state: "closed" });
		const n = await w.seedIssue({ state: "closed", body: `PR: #${pr}\n` });
		const facts = await readDependencies(w.forge, [n]);
		expect(facts[0]?.state).toBe("merged");
		expect(isReady(facts)).toBe(true);
	});
	it("abandoned without PR or with unmerged PR", async () => {
		const w = new MemoryWorld();
		const pr = await w.seedPullRequest({ head: "h", state: "closed" });
		const a = await w.seedIssue({ state: "closed" });
		const b = await w.seedIssue({ state: "closed", body: `PR: #${pr}\n` });
		const facts = await readDependencies(w.forge, [a, b]);
		expect(facts.map((f) => f.state)).toEqual(["abandoned", "abandoned"]);
		expect(isReady(facts)).toBe(false);
	});
	it("rejects on an unreadable dependency", async () => {
		const w = new MemoryWorld();
		await expect(readDependencies(w.forge, [999])).rejects.toThrow();
	});
});
