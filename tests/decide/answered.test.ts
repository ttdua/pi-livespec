import { describe, expect, test } from "vitest";
import { isBacked } from "../../src/decide/answered.ts";
import type { DecisionRecord } from "../../src/decide/records.ts";
import { behaviorConclusionComment } from "../../src/docs/behavior-change.ts";
import type { MarkedComment } from "../../src/forge/markers.ts";
import { ledgerRecord } from "../helpers/ledger.ts";

const ITEM = { capability: "rate-limit", files: ["src/rate.ts"] };
const BY = { by: "alice", at: "2026-01-01T00:00:00Z", from: "unchanged" };

function override(request?: string): { m: MarkedComment; record: DecisionRecord } {
	const m = ledgerRecord({ ...behaviorConclusionComment(ITEM, { source: "human", outcome: "changed", reason: "set by alice at the gate", overridden_by: BY, ...(request === undefined ? {} : { request }) }), kind: "decision" });
	return { m, record: m.data as DecisionRecord };
}

function gateAnswer(request: string, answer: Record<string, unknown>, verdict = "valid", source: MarkedComment["source"] = "forge"): MarkedComment {
	return { ref: `c-${request}`, source, kind: "answer", id: request, author: "bot", data: { request: { subject: "gate:define" }, answer, verdict } };
}

const changes = (capabilities: string[]) => ({ outcome: "changes_requested", behaviorOverrides: capabilities.map((capability) => ({ capability, outcome: "changed" })) });

describe("isBacked behavior overrides", () => {
	test("an override backed by its gate answer counts", () => {
		const { m, record } = override("gate-define.1");
		expect(isBacked([m, gateAnswer("gate-define.1", changes(["rate-limit"]))], m, record)).toBe(true);
	});

	test("an override without request, without answer, or with an invalid answer does not count", () => {
		const bare = override();
		expect(isBacked([bare.m], bare.m, bare.record)).toBe(false);
		const { m, record } = override("gate-define.1");
		expect(isBacked([m], m, record)).toBe(false);
		expect(isBacked([m, gateAnswer("gate-define.1", changes(["rate-limit"]), "superseded")], m, record)).toBe(false);
		expect(isBacked([m, gateAnswer("gate-define.1", changes(["rate-limit"]), "valid", "ledger")], m, record)).toBe(false);
	});

	test("an override whose answer lacks the capability or did not request changes does not count", () => {
		const { m, record } = override("gate-define.1");
		expect(isBacked([m, gateAnswer("gate-define.1", changes(["auth"]))], m, record)).toBe(false);
		expect(isBacked([m, gateAnswer("gate-define.1", { outcome: "changes_requested" })], m, record)).toBe(false);
		expect(isBacked([m, gateAnswer("gate-define.1", { ...changes(["rate-limit"]), outcome: "approved" })], m, record)).toBe(false);
	});

	test("a legacy human answer to a behavior request is still backed by its choice", () => {
		const m = ledgerRecord({ ...behaviorConclusionComment(ITEM, { source: "human", outcome: "unchanged", reason: "chosen by alice", request: "decide-behavior.1" }), kind: "decision" });
		const answer = gateAnswer("decide-behavior.1", { outcome: "answered", choice: "unchanged" });
		expect(isBacked([m, answer], m, m.data as DecisionRecord)).toBe(true);
		expect(isBacked([m, gateAnswer("decide-behavior.1", { outcome: "answered", choice: "changed" })], m, m.data as DecisionRecord)).toBe(false);
	});
});
