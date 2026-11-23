import { beforeEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { readCounters, setCounter } from "../../src/engine/counters.ts";
import { nextStep } from "../../src/engine/next-step.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import { deriveCommentFacts } from "../../src/engine/snapshot.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";
import { agg, aggregate } from "../review/review-fixtures.ts";
import { type MarkedComment, readMarkedComments, writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";

let world: MemoryWorld;
let n: number;

beforeEach(async () => {
	world = new MemoryWorld();
	n = await world.seedIssue({ title: "per-ip-cap", labels: ["livespec"] });
});

function marked(kind: string, id: string, data: unknown): MarkedComment {
	return { commentId: "c", kind, id, author: BOT_LOGIN, data };
}

async function own(): Promise<MarkedComment[]> {
	return (await readMarkedComments(world.forge, n)).comments;
}

/** The memory forge with comment creation counted. */
function countingCreates(forge: Forge, calls: { create: number }): Forge {
	return new Proxy(forge, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if (typeof value !== "function") return value;
			if (key === "createComment") return (...args: [number, string]) => (calls.create++, target.createComment(...args));
			return value.bind(target);
		},
	});
}

describe("readCounters", () => {
	test("reads counter values and ignores other kinds and malformed data", () => {
		const counters = readCounters([
			marked("counter", "custom_loop", { value: 2 }),
			marked("counter", "custom_loop.U3", { value: 1 }),
			marked("counter", "broken", { value: "two" }),
			marked("skill-note", "build.x", { value: 9 }),
		]);
		expect(counters).toEqual({ custom_loop: 2, "custom_loop.U3": 1 });
	});

	test("change_iterations counter comment is ignored", () => {
		const counters = readCounters([marked("counter", "change_iterations", { value: 3 }), marked("counter", "custom_loop", { value: 1 })]);
		expect(counters).toEqual({ custom_loop: 1 });
	});
});

describe("setCounter", () => {
	test("Counter update edits in place", async () => {
		await world.postComment(n, BOT_LOGIN, writeMarked("counter", "custom_loop", { value: 1 }));
		const calls = { create: 0 };
		await setCounter(countingCreates(world.forge, calls), n, "custom_loop", 2, await own());
		expect(calls.create).toBe(0);
		const after = await own();
		expect(after).toHaveLength(1);
		expect(readCounters(after)).toEqual({ custom_loop: 2 });
	});

	test("setCounter creates when missing", async () => {
		await setCounter(world.forge, n, "custom_loop.U3", 1, await own());
		expect(readCounters(await own())).toEqual({ "custom_loop.U3": 1 });
	});
});

describe("Derived unit attempts", () => {
	test("counter comments for unit_attempts.* are ignored", () => {
		const counters = readCounters([marked("counter", "unit_attempts.U2", { value: 9 }), marked("counter", "custom_loop", { value: 1 })]);
		expect(counters).toEqual({ custom_loop: 1 });
	});
});

describe("Derived review rounds", () => {
	test("a counter comment of 9 is ignored and every aggregate counts", async () => {
		const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
		if (!loaded.ok) throw new Error("default pack must load");
		const counter = marked("counter", "review_rounds", { value: 9 });
		expect(readCounters([counter])).toEqual({});
		const change = parseChange(FIXTURE_BODY);
		const facts = deriveCommentFacts([counter, aggregate([agg()], 1), aggregate([], 2)], change, { iterations: 5, unitAttempts: 3, reviewRounds: 3 });
		expect(facts.counters.review_rounds).toBe(2);
		const step = nextStep(loaded.pack, stateFor("review", { change, counters: facts.counters, evidence: facts.evidence }));
		expect(step.counters).toContainEqual({ name: "review_rounds", value: 2, cap: 3 });
	});
});
