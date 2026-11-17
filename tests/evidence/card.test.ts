import { beforeAll, describe, expect, test } from "vitest";
import { evidenceSection } from "../../src/evidence/card.ts";
import { nextStep } from "../../src/engine/next-step.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { parseChange } from "../../src/core/change.ts";
import { type CardInput, registerCardSection, renderCard, resetCardSectionsForTests } from "../../src/hooks/phase-card.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";

let pack: Pack;
beforeAll(async () => {
	const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
	if (!loaded.ok) throw new Error("default pack must load");
	pack = loaded.pack;
});

const BODY = FIXTURE_BODY.replace("- [ ] Q1 (blocking)", "- [x] Q1 (blocking)").replace("- [x] done", "- [ ] pending");
const START = { unit: "U1", digest: "d", verify: "v", pre: { sha: "abc1234".padEnd(40, "0") }, id: "U1.s", commentId: "c", index: 0 };

function card(over: Partial<ReturnType<typeof stateFor>["evidence"]>): CardInput {
	const state = stateFor("build", { change: parseChange(BODY), evidence: { started: {}, receipts: {}, attempts: {}, blocked: {}, untickedReceipts: [], ...over } });
	return { first: false, constraintsTemplate: false, unnotedSkills: [], kind: "change", step: nextStep(pack, state), state };
}

describe("evidence section", () => {
	test("Evidence shown", () => {
		const input = card({ started: { U1: START }, blocked: { U3: "progress" } });
		resetCardSectionsForTests();
		registerCardSection("evidence", evidenceSection);
		const text = renderCard(input);
		expect(text).toContain("Started: U1 at abc1234");
		expect(text).toContain("BLOCKED: U3 (reason progress)");
	});

	test("shows verifier-pending units and nothing when there is no evidence", () => {
		expect(evidenceSection(card({ started: { U1: { ...START, pending: true } } }))).toContain("Verifier pending: U1");
		expect(evidenceSection(card({}))).toBeUndefined();
		expect(evidenceSection({ first: false, constraintsTemplate: false, unnotedSkills: [], kind: "list", open: [] })).toBeUndefined();
	});
});
