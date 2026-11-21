// Tests of stage failures that must come back as a report, not a throw.
import { describe, expect, test } from "vitest";
import { runStage, type StageCtx } from "../../src/review/stages.ts";
import { stateFor } from "../helpers/change-state.ts";
import { run } from "./review-fixtures.ts";

describe("aggregateStage", () => {
	test("a git failure while reading the diff is a refusal", async () => {
		const git = { diffNameStatus: async () => { throw new Error("bad revision"); } };
		const c = { state: stateFor("review", { marked: [run()] }), w: { session: { git } } } as unknown as StageCtx;
		const report = await runStage({ stage: "aggregate" }, c);
		expect(report.error).toBe(true);
		expect(report.stop).toBe(true);
		expect(report.text).toContain("bad revision");
	});
});
