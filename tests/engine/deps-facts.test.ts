import { beforeAll, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { discoveredDeps, latestDependencyChoice } from "../../src/engine/deps-facts.ts";
import { nextStep } from "../../src/engine/next-step.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { deriveCommentFacts } from "../../src/engine/snapshot.ts";
import type { MarkedComment } from "../../src/forge/markers.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";

import { ledgerRecord } from "../helpers/ledger.ts";

let seq = 0;
/** A `counter` entry of the ledger. */
const counter = (id: string, data: unknown): MarkedComment => ledgerRecord({ kind: "counter", id, data });

function marked(kind: string, id: string, data: unknown): MarkedComment {
	seq += 1;
	return { source: "forge", ref: `c${seq}`, kind, id, author: "bot", data };
}

const DRAFTS = { unit: "U3", evidence: "e", a: { name: "token-store", proposal: "p" }, b: { units: ["U4"], summary: "s" }, c: { summary: "s", follow_up: { name: "f", proposal: "p" } }, d: { action: "drop", reason: "wrong direction" } };

/** A `new-dependency` request and its gate result; `choice` undefined leaves it out. */
function depGate(choice: string | undefined, o: { outcome?: string; superseded?: boolean; d?: { action: string; reason: string } } = {}): MarkedComment[] {
	seq += 1;
	const id = `gate-new-dependency.${seq}`;
	const drafts = { ...DRAFTS, ...(o.d ? { d: o.d } : {}) };
	const request = marked("request", id, { subject: "gate:new-dependency", kind: "gate", mode: "blocking", snapshot: { target: "new-dependency", failingWaivable: [], drafts } });
	const gate = marked("gate", `new-dependency.${id}`, {
		request: id,
		gate: "new-dependency",
		outcome: o.outcome ?? "approved",
		...(choice === undefined ? {} : { choice }),
		notes: "",
		by: "alice",
		at: "t",
		adapter: "forge",
		head_sha: "h",
		waivers: [],
		...(o.superseded ? { superseded: true } : {}),
	});
	return [request, gate];
}

const stuckAnswer = (choice = "A"): MarkedComment => marked("stuck", "S1-answer", { request: "stuck-S1.x", outcome: "approved", choice, notes: "", by: "alice", at: "t", adapter: "forge" });

let pack: Pack;
beforeAll(async () => {
	const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
	if (!loaded.ok) throw new Error("default pack must load");
	pack = loaded.pack;
});

const caps = { iterations: 5, unitAttempts: 3, reviewRounds: 3, discoveredDeps: 2 };

describe("discoveredDeps", () => {
	test("Counter shown", () => {
		const facts = deriveCommentFacts(depGate("A"), parseChange(FIXTURE_BODY), caps);
		expect(facts.counters.discovered_deps).toBe(1);
		const step = nextStep(pack, stateFor("build", { counters: facts.counters }));
		expect(step.counters).toContainEqual({ name: "discovered_deps", value: 1, cap: 2 });
	});

	test("Option D does not count", () => {
		expect(discoveredDeps(depGate("D"), 2)).toEqual({ value: 0, blocking: false });
	});

	test("Derived discovered dependencies", () => {
		const marks = [...depGate("A"), counter("discovered_deps", { value: 9 })];
		expect(deriveCommentFacts(marks, parseChange(FIXTURE_BODY), caps).counters.discovered_deps).toBe(1);
	});

	test("Counter shown with cap", () => {
		const facts = deriveCommentFacts([counter("custom_loop", { value: 1 })], parseChange(FIXTURE_BODY), caps);
		const step = nextStep({ ...pack, loops: { ...pack.loops, custom_loop: 2 } }, stateFor("build", { counters: facts.counters }));
		expect(step.counters).toContainEqual({ name: "custom_loop", value: 1, cap: 2 });
	});

	test("Cap exceeded", () => {
		const two = [...depGate("A"), ...depGate("B")];
		expect(discoveredDeps(two, 2)).toEqual({ value: 2, blocking: true });
		expect(discoveredDeps([...two, stuckAnswer()], 2)).toEqual({ value: 2, blocking: false });
		expect(discoveredDeps([...two, stuckAnswer("")], 2).blocking).toBe(true);
		expect(discoveredDeps([stuckAnswer(), ...two], 2).blocking).toBe(true);
	});

	test("approved without a choice counts", () => {
		expect(discoveredDeps(depGate(undefined), 2).value).toBe(1);
	});

	test("split, C and approved_with_notes count; superseded, changes requested and other gates do not", () => {
		const marks = [
			...depGate("split"),
			...depGate("C", { outcome: "approved_with_notes" }),
			...depGate("A", { superseded: true }),
			...depGate(undefined, { outcome: "changes_requested" }),
			marked("gate", "initiative.x", { request: "x", gate: "initiative", outcome: "approved", head_sha: "h", waivers: [] }),
		];
		expect(discoveredDeps(marks)).toEqual({ value: 2, blocking: false });
	});
});

describe("latestDependencyChoice", () => {
	test("none without a valid approved result", () => {
		expect(latestDependencyChoice([])).toBeUndefined();
		expect(latestDependencyChoice(depGate("A", { superseded: true }))).toBeUndefined();
	});

	test("the latest valid approved result, a missing choice as A, with D's action and reason", () => {
		const marks = [...depGate("B"), ...depGate("D", { d: { action: "drop", reason: "wrong direction" } })];
		expect(latestDependencyChoice(marks)).toEqual({ choice: "D", action: "drop", reason: "wrong direction", unit: "U3", index: 3 });
		expect(latestDependencyChoice(depGate(undefined))).toMatchObject({ choice: "A", index: 1 });
	});

	test("an unknown choice is ignored", () => {
		expect(latestDependencyChoice([...depGate("B"), ...depGate("Z")])).toMatchObject({ choice: "B" });
	});
});
