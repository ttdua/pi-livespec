// Tests of the finish gate's review requirement: `context>=N%` conditions never hold there.
import { describe, expect, test } from "vitest";
import type { Git } from "../../src/engine/git.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { finishGateRefusal } from "../../src/subagents/finish-gate.ts";
import type { SubagentEntry } from "../../src/subagents/roles.ts";
import { stateFor } from "../helpers/change-state.ts";

const git = { parents: async () => [] } as unknown as Git;

function packWith(entry: SubagentEntry): Pack {
	const empty = { requires: [] as string[], skills: { required: [] as string[], optional: [] as string[] }, outputs: [], redirects: [], checks: [] };
	return { name: "p", version: 1, content: "p", limits: {}, loops: {}, decisions: {}, init: { skills: [] }, phases: [{ ...empty, id: "build", per: "unit", gate: "none", subagents: [entry] }] } as unknown as Pack;
}

const busy = () => {
	const state = stateFor("build");
	state.subagents = { ...state.subagents, contextPercent: 95, turnsCompleted: 9 };
	return state;
};

describe("finish gate", () => {
	test("reviewRequired ignores context>=N%", async () => {
		const entry: SubagentEntry = { role: "reviewer", subject: "unit", mode: "auto", when: ["context>=50%"] };
		expect(await finishGateRefusal(busy(), packWith(entry), "U3", git)).toBeUndefined();
	});

	test("an always entry still requires the review", async () => {
		const entry: SubagentEntry = { role: "reviewer", subject: "unit", mode: "always" };
		expect(await finishGateRefusal(busy(), packWith(entry), "U3", git)).toContain("unit review");
	});
});
