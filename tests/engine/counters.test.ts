import { beforeEach, describe, expect, test } from "vitest";
import { readCounters, setCounter } from "../../src/engine/counters.ts";
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
			marked("counter", "review_rounds", { value: 2 }),
			marked("counter", "unit_attempts.U3", { value: 1 }),
			marked("counter", "broken", { value: "two" }),
			marked("skill-note", "build.x", { value: 9 }),
		]);
		expect(counters).toEqual({ review_rounds: 2, "unit_attempts.U3": 1 });
	});
});

describe("setCounter", () => {
	test("Counter update edits in place", async () => {
		await world.postComment(n, BOT_LOGIN, writeMarked("counter", "review_rounds", { value: 1 }));
		const calls = { create: 0 };
		await setCounter(countingCreates(world.forge, calls), n, "review_rounds", 2, await own());
		expect(calls.create).toBe(0);
		const after = await own();
		expect(after).toHaveLength(1);
		expect(readCounters(after)).toEqual({ review_rounds: 2 });
	});

	test("setCounter creates when missing", async () => {
		await setCounter(world.forge, n, "unit_attempts.U3", 1, await own());
		expect(readCounters(await own())).toEqual({ "unit_attempts.U3": 1 });
	});
});
