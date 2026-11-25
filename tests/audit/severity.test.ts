// drift-audit "Drift severity rule".

import { describe, expect, test } from "vitest";
import "../../src/decide/builtin.ts";
import { decide } from "../../src/decide/seam.ts";
import { type DriftItem, driftItem } from "../../src/audit/items.ts";
import { classify, severityFacts } from "../../src/audit/severity.ts";

const CONFIG = { config: { mode: "rule" }, subject: "x" };
const DEAD = driftItem("dead-paths", "rate-limit:src/gone/**", "matches nothing", "rate-limit");
const NONE = driftItem("declared-none", "pr#7:rate-limit", "declared none", "rate-limit");
const TERM = driftItem("unused-term", "Bucket", "used nowhere");

async function severityOf(items: DriftItem[], key: string): Promise<unknown> {
	const item = (await classify(items)).find((i) => i.key === key);
	return item && { severity: item.severity, route: item.route };
}

describe("Drift severity rule", () => {
	test("Major item", async () => {
		const d = await decide("drift-severity", { type: "dead-paths", capabilityHasMajor: false }, CONFIG);
		expect(d).toMatchObject({ status: "decided", outcome: { severity: "major", route: "change" }, source: "rule" });
		expect(await severityOf([DEAD], DEAD.key)).toEqual({ severity: "major", route: "change" });
	});

	test("Minor item", async () => {
		const d = await decide("drift-severity", { type: "unused-term", capabilityHasMajor: false }, CONFIG);
		expect(d).toMatchObject({ status: "decided", outcome: { severity: "minor", route: "small-fix" }, source: "rule" });
		expect(await severityOf([TERM], TERM.key)).toEqual({ severity: "minor", route: "small-fix" });
	});

	test("Declared none with other drift", async () => {
		expect(severityFacts(NONE, [NONE, DEAD])).toEqual({ type: "declared-none", capabilityHasMajor: true });
		const d = await decide("drift-severity", { type: "declared-none", capabilityHasMajor: true }, CONFIG);
		expect(d).toMatchObject({ outcome: { severity: "major", route: "change" } });
		expect(await severityOf([NONE, DEAD], NONE.key)).toEqual({ severity: "major", route: "change" });
	});

	test("Declared none alone", async () => {
		const otherCap = driftItem("dead-paths", "cache:src/x/**", "matches nothing", "cache");
		expect(severityFacts(NONE, [NONE, TERM, otherCap])).toEqual({ type: "declared-none", capabilityHasMajor: false });
		const d = await decide("drift-severity", { type: "declared-none", capabilityHasMajor: false }, CONFIG);
		expect(d).toMatchObject({ outcome: { severity: "minor", route: "small-fix" } });
		expect(await severityOf([NONE, TERM, otherCap], NONE.key)).toEqual({ severity: "minor", route: "small-fix" });
	});

	test("every type has its severity and classify keeps item fields", async () => {
		const major = ["scenario-untested", "removed-reference", "dead-paths"] as const;
		const minor = ["unused-term", "stale-decision", "product-missing"] as const;
		for (const type of major) expect((await decide("drift-severity", { type, capabilityHasMajor: false }, CONFIG)) as object).toMatchObject({ outcome: { severity: "major" } });
		for (const type of minor) expect((await decide("drift-severity", { type, capabilityHasMajor: true }, CONFIG)) as object).toMatchObject({ outcome: { severity: "minor" } });
		const [c] = await classify([DEAD]);
		expect(c).toEqual({ ...DEAD, severity: "major", route: "change" });
	});
});
