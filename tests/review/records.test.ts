// Tests of the review-run marker and the aggregate and verifier record queries.
import { describe, expect, it } from "vitest";
import { invalidRecords } from "../../src/subagents/records.ts";
import { aggregateOf, latestRun, runAtHead, verifierRecord } from "../../src/review/records.ts";
import { agg, aggregate, run, verifier } from "./review-fixtures.ts";

describe("review-run", () => {
	it("has id review-run.<round> and the latest comment of an id wins", () => {
		const first = run();
		const routed = run({ routed: true });
		expect(first.id).toBe("review-run.1");
		expect(latestRun([first, routed])).toMatchObject({ round: 1, routed: true, commentId: routed.ref });
		expect(latestRun([])).toBeUndefined();
	});

	it("a new HEAD restarts the round with the same id", () => {
		const a = run({ head: "a1", round: 2 });
		const b = run({ head: "b2", round: 2 });
		expect(runAtHead([a, b], "b2")).toMatchObject({ round: 2, head: "b2" });
		expect(runAtHead([a, b], "a1")).toBeUndefined();
	});

	it("malformed review-run data is ignored", () => {
		const bad = { ...run(), data: { round: "one" } };
		expect(latestRun([bad])).toBeUndefined();
		const good = run();
		const badFinding = { ...good, data: { ...(good.data as object), parentFindings: [{ severity: "HIGH", kind: "defect", location: "a:1", evidence: "e", fix: "f", scope: "unit" }] } };
		expect(latestRun([badFinding])).toBeUndefined();
	});
});

describe("aggregate and verifier records", () => {
	it("the aggregate has the round id and valid finding-summary data", () => {
		const a = aggregate([agg()], 2);
		expect(a.id).toBe("finding-summary.change.review.2");
		expect(invalidRecords([a])).toEqual([]);
		expect(aggregateOf([a], 2)).toMatchObject({ commentId: a.ref, data: { aggregate: true, round: 2, reviews: ["r1"] } });
		expect(aggregateOf([a], 1)).toBeUndefined();
	});

	it("verifierRecord is the latest completed or BLOCKED verifier record of the key", () => {
		const first = verifier("c1:0", { status: "BLOCKED", completed: false, verdict: undefined });
		const second = verifier("c1:0", { round: 2, verdict: "refuted" });
		const partial = verifier("c1:0", { round: 3, status: "DONE_WITH_CONCERNS", completed: false, verdict: "confirmed" });
		expect(verifierRecord([first, second, partial, verifier("c1:1")], "c1:0")).toMatchObject({ verdict: "refuted" });
		expect(verifierRecord([first], "c1:0")).toMatchObject({ status: "BLOCKED" });
		expect(verifierRecord([partial], "c1:0")).toBeUndefined();
		expect(verifierRecord([first], "c1:9")).toBeUndefined();
	});
});
