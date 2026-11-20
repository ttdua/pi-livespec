// Tests of the inline path: `subagent_packet` and `subagent_record` leave the same records as a dispatched run.
import { afterEach, describe, expect, test } from "vitest";
import { setSession } from "../../src/hooks/session-store.ts";
import { done, unpublish } from "../subagents/fake-executor.ts";
import { cleanupDirs, textOf } from "./helpers.ts";
import { cardState } from "./unit-helpers.ts";
import { footerIds, subagentHarness, U1 } from "./subagent-helpers.ts";

afterEach(async () => {
	unpublish();
	setSession(undefined);
	await cleanupDirs();
});

const FINDING = { severity: "WARNING", kind: "defect", location: "src/u1.ts:1", evidence: "off by one", fix: "use >=", scope: "unit" };
const reviewResult = (over: Record<string, unknown> = {}) => ({ status: "DONE", notes: "n", discoveries: [], sources_used: [], findings: [FINDING], ...over });

describe("inline fallback", () => {
	test("no executor", async () => {
		const h = await subagentHarness({ units: [U1] });
		await h.start("U1");
		const { step } = cardState(h);
		expect(step.next).toContain("subagent_packet implementer U1");
		expect(step.next).toContain("subagent_record implementer U1");
		const out = await h.call("subagent_dispatch", { role: "implementer", unit: "U1" });
		expect(textOf(out)).toContain("runs inline");
		expect(textOf(out)).toContain("subagent_record implementer U1");
		const packet = await h.call("subagent_packet", { role: "implementer", unit: "U1" });
		expect(textOf(packet)).toContain("# livespec packet protocol");
		const recorded = await h.call("subagent_record", { role: "implementer", unit: "U1", result: done({ commits: [], sources_used: footerIds(textOf(packet)) }) });
		expect(recorded.isError, textOf(recorded)).toBeFalsy();
		expect((await h.latest("dispatch"))?.data).toMatchObject({ role: "implementer", unit: "U1", status: "DONE", agentSource: "inline", attempt: 1 });
		await h.commit({ "src/u1.ts": "export const x = 1;\n" });
		expect(cardState(h).step.next).toContain("subagent_record reviewer U1 unit");
		const brief = textOf(await h.call("subagent_packet", { role: "reviewer", unit: "U1", subject: "unit" }));
		const cited = footerIds(brief);
		const review = await h.call("subagent_record", { role: "reviewer", unit: "U1", subject: "unit", result: reviewResult({ findings: [], sources_used: cited }) });
		expect(review.isError, textOf(review)).toBeFalsy();
		const finished = await h.finish("U1");
		expect(finished.isError, textOf(finished)).toBeFalsy();
		expect(await h.ofKind("receipt")).toHaveLength(1);
	});

	test("inline review recorded", async () => {
		const h = await subagentHarness({ units: [U1] });
		await h.start("U1");
		const cited = footerIds(textOf(await h.call("subagent_packet", { role: "reviewer", unit: "U1", subject: "unit" })));
		const out = await h.call("subagent_record", { role: "reviewer", unit: "U1", subject: "unit", result: reviewResult({ sources_used: cited }) });
		expect(out.isError, textOf(out)).toBeFalsy();
		const summary = await h.latest("finding-summary");
		expect(summary?.data).toMatchObject({ role: "reviewer", subject: "unit", unit: "U1", round: 1, status: "DONE", findings: [FINDING], head: h.git("rev-parse", "HEAD"), agentSource: "inline" });
		expect(summary?.data).not.toHaveProperty("agentId");
	});

	test("subagent_record validates the result against the role schema", async () => {
		const h = await subagentHarness({ units: [U1] });
		const before = (await h.marked()).length;
		const out = await h.call("subagent_record", { role: "reviewer", unit: "U1", subject: "unit", result: reviewResult({ findings: undefined }) });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("findings is required");
		const blocked = await h.call("subagent_record", { role: "implementer", unit: "U1", result: done({ status: "BLOCKED", reason: "r" }) });
		expect(textOf(blocked)).toContain("needs reason and evidence");
		expect(await h.marked()).toHaveLength(before);
	});

	test("a reviewer finding without location is refused and nothing is posted", async () => {
		const h = await subagentHarness({ units: [U1] });
		const before = (await h.marked()).length;
		const { location: _location, ...noLocation } = FINDING;
		const out = await h.call("subagent_record", { role: "reviewer", unit: "U1", subject: "unit", result: reviewResult({ findings: [noLocation] }) });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("location");
		expect(await h.marked()).toHaveLength(before);
	});

	test("inline result omitting a required source is refused", async () => {
		const h = await subagentHarness({ units: [U1] });
		const before = (await h.marked()).length;
		const out = await h.call("subagent_record", { role: "implementer", unit: "U1", result: done() });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("omits required sources");
		expect(await h.marked()).toHaveLength(before);
	});

	test("inline NEEDS_CONTEXT past the cap points to spec_stuck", async () => {
		const h = await subagentHarness({ units: [U1] });
		const cited = footerIds(textOf(await h.call("subagent_packet", { role: "implementer", unit: "U1" })));
		const nc = done({ status: "NEEDS_CONTEXT", reason: "need spec:auth", evidence: "missing", sources_used: cited });
		for (let i = 0; i < 2; i++) expect(textOf(await h.call("subagent_record", { role: "implementer", unit: "U1", result: nc }))).toContain("Sources named: <untrusted>spec:auth");
		const third = await h.call("subagent_record", { role: "implementer", unit: "U1", result: nc });
		expect(textOf(third)).toContain("spec_stuck");
	});
});
