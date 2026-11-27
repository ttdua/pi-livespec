import { beforeAll, describe, expect, test } from "vitest";
import { gateEscalationFacts } from "../../src/engine/gate-escalation-facts.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { INLINE_SOURCE } from "../../src/subagents/run-record.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";
import { finding, reviewed } from "../subagents/helpers.ts";

const HEAD = "f".repeat(40);
let pack: Pack;

beforeAll(async () => {
	const loaded = await loadPack(process.cwd());
	if (!loaded.ok) throw new Error("default pack must load");
	pack = loaded.pack;
});

/** U1 tagged `ui`, U3 untagged. */
const BODY = FIXTURE_BODY.replace("Tags: []", "Tags: [ui]").replace("Tags: [security, api]", "Tags: []");

const planReview = (over: Parameters<typeof reviewed>[0] = {}) => reviewed({ subject: "plan", unit: undefined, advisory: true, head: HEAD, ...over });

describe("gateEscalationFacts", () => {
	test("facts from the ledger", () => {
		const state = stateFor("plan", { marked: [planReview({ findings: [finding({ severity: "WARNING" })] })] }, BODY);
		expect(gateEscalationFacts(state, pack, "plan", [])).toEqual({
			phase: "plan",
			head_sha: HEAD,
			failing_waivable: [],
			advisory_review: "clean",
			units: [{ id: "U1", tags: ["ui"] }, { id: "U3", tags: [] }],
		});
	});

	test("failing waivable checks are kept", () => {
		expect(gateEscalationFacts(stateFor("plan", {}, BODY), pack, "plan", ["size-limits"]).failing_waivable).toEqual(["size-limits"]);
	});

	test("critical at HEAD", () => {
		const state = stateFor("plan", { marked: [planReview({ findings: [finding({ severity: "CRITICAL" })] })] }, BODY);
		expect(gateEscalationFacts(state, pack, "plan", []).advisory_review).toBe("critical");
	});

	test("the latest review at HEAD decides", () => {
		const older = planReview({ round: 1, findings: [finding({ severity: "CRITICAL" })] });
		const newer = planReview({ round: 2, findings: [] });
		expect(gateEscalationFacts(stateFor("plan", { marked: [older, newer] }, BODY), pack, "plan", []).advisory_review).toBe("clean");
	});

	test("review at older head", () => {
		const state = stateFor("plan", { marked: [planReview({ head: "e".repeat(40) })] }, BODY);
		expect(gateEscalationFacts(state, pack, "plan", []).advisory_review).toBe("missing");
	});

	test("an incomplete review is missing", () => {
		const state = stateFor("plan", { marked: [planReview({ completed: false, status: "BLOCKED" })] }, BODY);
		expect(gateEscalationFacts(state, pack, "plan", []).advisory_review).toBe("missing");
	});

	test("inline review recorded with subagent_record counts", () => {
		const state = stateFor("plan", { marked: [planReview({ agentSource: INLINE_SOURCE })] }, BODY);
		expect(gateEscalationFacts(state, pack, "plan", []).advisory_review).toBe("clean");
	});

	test("phase without advisory reviewer", () => {
		expect(gateEscalationFacts(stateFor("shape", {}, BODY), pack, "shape", []).advisory_review).toBe("none");
	});

	test("an off reviewer entry is none", () => {
		const off: Pack = { ...pack, phases: pack.phases.map((p) => (p.id === "plan" ? { ...p, subagents: [{ role: "reviewer", subject: "plan", mode: "off", advisory: true }] } : p)) };
		expect(gateEscalationFacts(stateFor("plan", {}, BODY), off, "plan", []).advisory_review).toBe("none");
	});
});
