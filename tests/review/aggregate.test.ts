// Tests of de-duplication and routing of aggregate findings (design D3).
import { describe, expect, it } from "vitest";
import { mergeFindings, withRoutes } from "../../src/review/aggregate.ts";
import { finding } from "./review-fixtures.ts";

const unit = { route: "unit" as const, unit: "U2" };

describe("mergeFindings", () => {
	it("Two reviewers, one defect", () => {
		const merged = mergeFindings({
			parent: [],
			reviews: [
				{ commentId: "c1", findings: [finding({ severity: "WARNING", location: "src/limit.ts:10", evidence: "first" })] },
				{ commentId: "c2", findings: [finding({ severity: "CRITICAL", location: "./src/limit.ts:10", evidence: "second" })] },
			],
		});
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ severity: "CRITICAL", kind: "defect", location: "src/limit.ts:10", evidence: "first", from: ["c1:0", "c2:0"] });
		const routed = withRoutes(merged, [unit], true);
		expect(routed[0]).toMatchObject({ route: "unit", routeUnit: "U2", verify: "skipped-off" });
		expect(withRoutes(merged, [unit], false)[0]?.verify).toBe("required");
	});

	it("Same file, other line", () => {
		const merged = mergeFindings({ parent: [], reviews: [{ commentId: "c1", findings: [finding({ location: "src/limit.ts:10" })] }, { commentId: "c2", findings: [finding({ location: "src/limit.ts:40" })] }] });
		expect(merged).toHaveLength(2);
	});

	it("a Windows path, no line and line 1 are one finding; another kind is not", () => {
		const merged = mergeFindings({
			parent: [],
			reviews: [{ commentId: "c1", findings: [finding({ location: "src\\a.ts" }), finding({ location: "/src/a.ts:1:4" }), finding({ location: "src/a.ts:1", kind: "other" })] }],
		});
		expect(merged.map((f) => [f.location, f.kind, f.from])).toEqual([["src/a.ts:1", "defect", ["c1:0", "c1:1"]], ["src/a.ts:1", "other", ["c1:2"]]]);
	});

	it("keeps the needs-decision mark when any merged finding has it", () => {
		const merged = mergeFindings({ parent: [], reviews: [{ commentId: "c1", findings: [finding()] }, { commentId: "c2", findings: [finding({ scope: "needs-decision" })] }] });
		expect(merged[0]?.needsDecision).toBe(true);
		expect(mergeFindings({ parent: [], reviews: [{ commentId: "c1", findings: [finding()] }] })[0]?.needsDecision).toBe(false);
	});

	it("parent findings come first and are marked parent", () => {
		const merged = mergeFindings({ parent: [finding({ severity: "CRITICAL", location: "src/u2.ts:1" })], reviews: [{ commentId: "c1", findings: [finding({ location: "src/u2.ts:1" })] }] });
		expect(merged).toEqual([expect.objectContaining({ from: ["parent", "c1:0"], severity: "CRITICAL" })]);
	});
});

describe("withRoutes", () => {
	it("parent, missed-context and suggestion findings skip the verifier", () => {
		const merged = mergeFindings({
			parent: [finding({ location: "p.ts:1" })],
			reviews: [{ commentId: "c1", findings: [finding({ location: "m.ts:1", kind: "missed-context" }), finding({ location: "s.ts:1", severity: "SUGGESTION" })] }],
		});
		const routed = withRoutes(merged, [unit, { route: "in-change" }, { route: "record" }], false);
		expect(routed.map((f) => f.verify)).toEqual(["skipped-parent", "skipped-missed-context", "skipped-suggestion"]);
		expect(routed[1]).not.toHaveProperty("routeUnit");
	});
});

it("a check location is kept as written", () => {
	const f = finding({ severity: "CRITICAL", location: "check:ci/test" });
	expect(mergeFindings({ parent: [f, f], reviews: [] }).map((m) => m.location)).toEqual(["check:ci/test"]);
});
