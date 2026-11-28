import { beforeEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { readCounters, setCounter } from "../../src/engine/counters.ts";
import { nextStep } from "../../src/engine/next-step.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import { deriveCommentFacts } from "../../src/engine/snapshot.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";
import { agg, aggregate } from "../review/review-fixtures.ts";
import { type MarkedComment, readMarkedComments } from "../../src/forge/markers.ts";
import { type LedgerEntry, newRef } from "../../src/ledger/entry.ts";
import type { Ledger } from "../../src/ledger/index.ts";
import { mergeRecords } from "../../src/ledger/merge.ts";
import { emptyLedger, ledgerRecord } from "../helpers/ledger.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";

let world: MemoryWorld;
let n: number;

beforeEach(async () => {
	world = new MemoryWorld();
	n = await world.seedIssue({ title: "per-ip-cap", labels: ["livespec"] });
});

/** A `counter` entry of the ledger. */
const counter = (id: string, data: unknown): MarkedComment => ledgerRecord({ kind: "counter", id, data });

function marked(kind: string, id: string, data: unknown): MarkedComment {
	return { source: "forge", ref: "c", kind, id, author: BOT_LOGIN, data };
}

async function own(): Promise<MarkedComment[]> {
	return (await readMarkedComments(world.forge, n)).comments;
}

/** An in-memory ledger that keeps what is appended to it. */
function recordingLedger(): { ledger: Ledger; entries: LedgerEntry[] } {
	const entries: LedgerEntry[] = [];
	const ledger: Ledger = {
		...emptyLedger(),
		append: async (_n, input) => {
			const entry: LedgerEntry = { ref: newRef(input.id), kind: input.kind, id: input.id, seq: entries.length + 1, at: new Date().toISOString(), ...(input.after === undefined ? {} : { after: input.after }), data: input.data };
			entries.push(entry);
			return entry;
		},
		read: async () => ({ entries: [...entries], warnings: [] }),
	};
	return { ledger, entries };
}

describe("readCounters", () => {
	test("reads counter values and ignores other kinds and malformed data", () => {
		const counters = readCounters([
			counter("custom_loop", { value: 2 }),
			counter("custom_loop.U3", { value: 1 }),
			counter("broken", { value: "two" }),
			marked("skill-note", "build.x", { value: 9 }),
		]);
		expect(counters).toEqual({ custom_loop: 2, "custom_loop.U3": 1 });
	});

	test("change_iterations counter comment is ignored", () => {
		const counters = readCounters([counter("change_iterations", { value: 3 }), counter("custom_loop", { value: 1 })]);
		expect(counters).toEqual({ custom_loop: 1 });
	});
});

describe("setCounter", () => {
	test("Counter update edits in place", async () => {
		const { ledger, entries } = recordingLedger();
		await setCounter(ledger, n, "custom_loop", 1);
		const first = { ...entries[0] };
		await setCounter(ledger, n, "custom_loop", 2);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toEqual(first);
		expect(readCounters(mergeRecords([], entries))).toEqual({ custom_loop: 2 });
		expect(await own()).toEqual([]);
	});

	test("setCounter appends when missing, anchored after the given comment", async () => {
		const { ledger, entries } = recordingLedger();
		await setCounter(ledger, n, "custom_loop.U3", 1, "c9");
		expect(entries[0]).toMatchObject({ kind: "counter", id: "custom_loop.U3", after: "c9", data: { value: 1 } });
		expect(readCounters(mergeRecords([], entries))).toEqual({ "custom_loop.U3": 1 });
	});
});

describe("Derived unit attempts", () => {
	test("counter comments for unit_attempts.* are ignored", () => {
		const counters = readCounters([counter("unit_attempts.U2", { value: 9 }), counter("custom_loop", { value: 1 })]);
		expect(counters).toEqual({ custom_loop: 1 });
	});
});

describe("Derived review rounds", () => {
	test("a counter comment of 9 is ignored and every aggregate counts", async () => {
		const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
		if (!loaded.ok) throw new Error("default pack must load");
		const nine = counter("review_rounds", { value: 9 });
		expect(readCounters([nine])).toEqual({});
		const change = parseChange(FIXTURE_BODY);
		const facts = deriveCommentFacts([nine, aggregate([agg()], 1), aggregate([], 2)], change, { iterations: 5, unitAttempts: 3, reviewRounds: 3 });
		expect(facts.counters.review_rounds).toBe(2);
		const step = nextStep(loaded.pack, stateFor("review", { change, counters: facts.counters, evidence: facts.evidence }));
		expect(step.counters).toContainEqual({ name: "review_rounds", value: 2, cap: 3 });
	});
});
