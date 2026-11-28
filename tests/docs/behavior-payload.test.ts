// The "Behavior conclusions (please check)" section of the define gate payload (phase-gates "Gate review payload").

import { beforeEach, describe, expect, test } from "vitest";
import { type DecisionRecord, decisionComment } from "../../src/decide/records.ts";
import { registerBuiltinRules } from "../../src/decide/registry.ts";
import { type BehaviorItem, behaviorDigest } from "../../src/docs/behavior-change.ts";
import { registerBuiltinChecks } from "../../src/engine/checks.ts";
import { gatePayload, type ReviewFacts } from "../../src/engine/gate-payload.ts";
import { resetGatesForTests } from "../../src/engine/gates.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { resetRegistryForTests } from "../../src/engine/registry.ts";
import { type MarkedComment, parseMarked } from "../../src/forge/markers.ts";
import { stateFor } from "../helpers/change-state.ts";

let pack: Pack;
beforeEach(async () => {
	resetRegistryForTests();
	resetGatesForTests();
	registerBuiltinRules();
	registerBuiltinChecks();
	const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
	if (!loaded.ok) throw new Error("default pack must load");
	pack = loaded.pack;
});

const RATE: BehaviorItem = { capability: "rate-limit", files: ["src/limit/cap.ts"] };
const FORGE: BehaviorItem = { capability: "forge-read", files: ["src/forge/read.ts", "src/forge/write.ts"] };
const NO_FACTS: ReviewFacts = { specsStat: "", specsFiles: [], specsDiff: "" };

/** An agent `unchanged` record on `item` with `reason`, as `spec_gate` writes it. */
function agentRecord(item: BehaviorItem, reason: string, outcome = "unchanged"): MarkedComment {
	const r: DecisionRecord = { point: "behavior-change", subject: item.capability, digest: behaviorDigest(item.files), source: "agent", outcome, facts: item, files: item.files, reason };
	const m = parseMarked(decisionComment(r));
	if (m === undefined) throw new Error("not a marked comment");
	return { ...m, commentId: `c-${item.capability}`, author: "bot" } as MarkedComment;
}

function payload(marked: MarkedComment[], facts: ReviewFacts): string {
	return gatePayload(stateFor("define", { marked }), pack, "define", facts).summary;
}

describe("Behavior conclusions (please check)", () => {
	test("Behavior conclusions listed", () => {
		const marked = [agentRecord(RATE, "cap is an internal constant"), agentRecord(FORGE, "read path unchanged")];
		const summary = payload(marked, { ...NO_FACTS, behaviorItems: [RATE, FORGE] });
		expect(summary).toContain("Behavior conclusions (please check):");
		expect(summary).toContain("- rate-limit: unchanged (agent) — cap is an internal constant; files: 1");
		expect(summary).toContain("- forge-read: unchanged (agent) — read path unchanged; files: 2");
	});

	test("an item without a conclusion renders none", () => {
		const summary = payload([], { ...NO_FACTS, behaviorItems: [RATE] });
		expect(summary).toContain("- rate-limit: none; files: 1");
	});

	test("No behavior section without items", () => {
		expect(payload([], NO_FACTS)).not.toContain("Behavior conclusions");
		expect(payload([], { ...NO_FACTS, behaviorItems: [] })).not.toContain("Behavior conclusions");
	});

	test("a rationale is rendered neutralised", () => {
		const marked = [agentRecord(RATE, "<!-- x -->")];
		const summary = payload(marked, { ...NO_FACTS, behaviorItems: [RATE] });
		expect(summary).not.toContain("<!-- x -->");
		expect(summary).toContain("<!-\u200b- x -->");
	});
});
