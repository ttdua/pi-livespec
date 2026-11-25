import { describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { productImpactResults } from "../../src/docs/product-impact.ts";

const change = (impact: string | undefined, caps = "new [], modified [rate-limit]") =>
	parseChange(`Base: abc\nCapabilities: ${caps}\n${impact === undefined ? "" : `Product impact: ${impact}\n`}\n## Proposal\nx\n`);

describe("product-impact", () => {
	test("Missing product impact blocks: dash", () => {
		const out = productImpactResults(change("—"));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ code: "product-impact", severity: "error" });
	});
	test("None with a reason", () => {
		expect(productImpactResults(change("none — internal refactor"))).toEqual([]);
	});
	test("None with a new capability", () => {
		const out = productImpactResults(change("none — small", "new [cache], modified []"));
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("cache");
	});
	test("Updated", () => {
		expect(productImpactResults(change("updated"))).toEqual([]);
	});
	test("none with an empty reason is an error", () => {
		expect(productImpactResults(change("none — "))).toHaveLength(1);
		expect(productImpactResults(change("none"))).toHaveLength(1);
	});
	test("missing line is an error", () => {
		expect(productImpactResults(change(undefined))).toHaveLength(1);
	});
});
