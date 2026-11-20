// Tests of reviewer selection and the tag re-check of a review round.
import { beforeAll, describe, expect, test } from "vitest";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { selectSubjects } from "../../src/review/select.ts";
import { retag } from "../../src/review/retag.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";
import { changeBody } from "../tools/unit-helpers.ts";

let pack: Pack;
beforeAll(async () => {
	const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
	if (!loaded.ok) throw new Error("default pack must load");
	pack = loaded.pack;
});

const HEAD = "Base: 0123456789abcdef0123456789abcdef01234567\nBranch: livespec/per-ip-cap\n";
const bodyOf = (ids: string[]): string => HEAD + changeBody(ids.map((id) => ({ id, verify: "true" })));

describe("selectSubjects", () => {
	test("Security tag from the plan", () => {
		// The fixture has 2 units; U3 carries `security`.
		expect(selectSubjects(pack, stateFor("review", {}, FIXTURE_BODY), [])).toEqual(["change", "persona:security-auditor"]);
	});

	test("Three units", () => {
		expect(selectSubjects(pack, stateFor("review", {}, bodyOf(["U1", "U2", "U3"])), [])).toEqual(["change", "persona:test-engineer"]);
	});

	test("re-checked tags count", () => {
		expect(selectSubjects(pack, stateFor("review", {}, bodyOf(["U1"])), ["perf"])).toEqual(["change", "persona:web-performance-auditor"]);
	});

	test("context>=N% never holds", () => {
		const p: Pack = { ...pack, phases: pack.phases.map((ph) => (ph.id === "review" ? { ...ph, subagents: [...(ph.subagents ?? []), { role: "reviewer", subject: "persona:ctx", mode: "auto", when: ["context>=10%"] }] } : ph)) };
		const state = stateFor("review", {}, bodyOf(["U1"]));
		const busy = { ...state, subagents: { ...state.subagents, contextPercent: 99, turnsCompleted: 5 } };
		expect(selectSubjects(p, busy, [])).toEqual(["change"]);
	});
});

describe("retag", () => {
	test("Auth file without a security tag", () => {
		const state = stateFor("review", {}, bodyOf(["U1", "U2"]));
		const tags = retag(pack, state, ["src/auth/session.ts"]);
		expect(tags).toEqual(["security"]);
		expect(selectSubjects(pack, state, tags)).toContain("persona:security-auditor");
		expect(state.change.units.every((u) => (u.tags ?? []).length === 0)).toBe(true);
	});

	test("tags a unit already carries are dropped", () => {
		expect(retag(pack, stateFor("review", {}, FIXTURE_BODY), ["src/auth/session.ts", "src/api/x.ts"])).toEqual([]);
	});
});
