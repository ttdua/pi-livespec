import { beforeEach, describe, expect, test } from "vitest";
import { resolveChange } from "../../src/engine/resolve-change.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";

let world: MemoryWorld;

beforeEach(() => {
	world = new MemoryWorld();
});

function body(branch?: string): string {
	return `${branch ? `Branch: ${branch}\n` : ""}Capabilities: new [], modified []\n\n## Proposal\n`;
}

async function change(title: string, opts: { branch?: string; phase?: string; state?: "open" | "closed"; labels?: string[] } = {}): Promise<number> {
	const labels = opts.labels ?? ["livespec", ...(opts.phase ? [`livespec:phase/${opts.phase}`] : [])];
	return world.seedIssue({ title, body: body(opts.branch), labels, state: opts.state });
}

describe("resolveChange", () => {
	test("resolves by Branch line", async () => {
		await change("other", { branch: "livespec/other", phase: "build" });
		const n = await change("renamed-title", { branch: "livespec/rate-limit", phase: "define" });
		await change("rate-limit", { phase: "shape" });
		expect(await resolveChange(world.forge, "livespec/rate-limit")).toEqual({ kind: "change", number: n });
	});

	test("resolves by title with a warning", async () => {
		const n = await change("rate-limit", { phase: "shape" });
		const resolved = await resolveChange(world.forge, "livespec/rate-limit");
		expect(resolved).toEqual({
			kind: "change",
			number: n,
			warning: `Change #${n} matches livespec/rate-limit by title only: its Branch: line is not recorded.`,
		});
	});

	test("title fallback skips issues that record another branch", async () => {
		const n = await change("rate-limit", { branch: "livespec/rate-limit-v2", phase: "build" });
		expect(await resolveChange(world.forge, "livespec/rate-limit")).toEqual({
			kind: "none",
			open: [{ number: n, title: "rate-limit", phase: "build" }],
		});
	});

	test("several matches is an error", async () => {
		const a = await change("one", { branch: "livespec/rate-limit", phase: "build" });
		const b = await change("two", { branch: "livespec/rate-limit", phase: "build" });
		expect(await resolveChange(world.forge, "livespec/rate-limit")).toEqual({
			kind: "error",
			message: `Several open changes match livespec/rate-limit: #${a}, #${b}. Keep the Branch: line on one issue only.`,
		});
	});

	test("several title matches is an error", async () => {
		const a = await change("rate-limit");
		const b = await change("rate-limit");
		const resolved = await resolveChange(world.forge, "livespec/rate-limit");
		expect(resolved).toEqual({
			kind: "error",
			message: `Several open changes match livespec/rate-limit: #${a}, #${b}. Keep the Branch: line on one issue only.`,
		});
	});

	test("closed and unlabelled issues are ignored", async () => {
		await change("rate-limit", { branch: "livespec/rate-limit", state: "closed" });
		await change("rate-limit", { branch: "livespec/rate-limit", labels: [] });
		const resolved = await resolveChange(world.forge, "livespec/rate-limit");
		expect(resolved).toEqual({ kind: "none", open: [] });
	});

	test("other branch lists open changes capped at 10", async () => {
		const numbers: number[] = [];
		for (let i = 1; i <= 12; i++) numbers.push(await change(`change-${i}`, { phase: i === 1 ? "build" : undefined }));
		await change("closed-one", { state: "closed" });
		const resolved = await resolveChange(world.forge, "main");
		expect(resolved.kind).toBe("none");
		if (resolved.kind !== "none") return;
		expect(resolved.open).toHaveLength(10);
		expect(resolved.open[0]).toEqual({ number: numbers[0], title: "change-1", phase: "build" });
		expect(resolved.open[1]).toEqual({ number: numbers[1], title: "change-2" });
	});

	test("Branch line on a non-livespec branch does not resolve", async () => {
		const n = await change("odd", { branch: "main", phase: "build" });
		expect(await resolveChange(world.forge, "main")).toEqual({
			kind: "none",
			open: [{ number: n, title: "odd", phase: "build" }],
		});
	});

	test("livespec branch without a match lists open changes", async () => {
		const n = await change("other", { phase: "plan" });
		expect(await resolveChange(world.forge, "livespec/rate-limit")).toEqual({
			kind: "none",
			open: [{ number: n, title: "other", phase: "plan" }],
		});
	});
});
