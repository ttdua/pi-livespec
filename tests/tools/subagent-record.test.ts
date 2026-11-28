// Tests of the inline path: `subagent_packet` and `subagent_record` leave the same records as a dispatched run.
import { afterEach, describe, expect, test } from "vitest";
import { setSession } from "../../src/hooks/session-store.ts";
import { done, unpublish } from "../subagents/fake-executor.ts";
import { readPacket } from "../../src/subagents/packet-store.ts";
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
		expect(await h.inLedger("dispatch")).toHaveLength(1);
		expect(await h.commentsOf("dispatch")).toEqual([]);
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

	test("inline record ignores a finding for an implementer", async () => {
		const h = await subagentHarness({ units: [U1] });
		await h.start("U1");
		const packet = await h.call("subagent_packet", { role: "implementer", unit: "U1" });
		const out = await h.call("subagent_record", { role: "implementer", unit: "U1", finding: "c1:0", result: done({ commits: [], sources_used: footerIds(textOf(packet)) }) });
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(textOf(out).startsWith('Warning: ignored finding "c1:0": only verifier takes a finding reference.')).toBe(true);
		const data = (await h.latest("dispatch"))?.data as Record<string, unknown>;
		expect(data).toMatchObject({ role: "implementer", unit: "U1", status: "DONE", agentSource: "inline", attempt: 1 });
		expect(data).not.toHaveProperty("finding");
		expect(data).not.toHaveProperty("verifies");
		expect(textOf(packet)).toContain(data.packet as string);
		expect(await readPacket(h.root, "per-ip-cap", data.packet as string)).toBeDefined();
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
		expect((await h.inLedger("finding-summary")).map((m) => m.ref)).toEqual([summary?.ref]);
		expect(await h.commentsOf("finding-summary")).toEqual([]);
	});

	test("a reviewer recording without optional sources is accepted", async () => {
		const h = await subagentHarness({ units: [U1] });
		await h.seed("decision", "tags.d0", { tags: ["x"] });
		await h.start("U1");
		const footer = footerIds(textOf(await h.call("subagent_packet", { role: "reviewer", unit: "U1", subject: "unit" })));
		expect(footer).toContain("records:decisions");
		const cited = footer.filter((id) => !id.startsWith("records:"));
		const out = await h.call("subagent_record", { role: "reviewer", unit: "U1", subject: "unit", result: reviewResult({ findings: [], sources_used: cited }) });
		expect(out.isError, textOf(out)).toBeFalsy();
		expect((await h.latest("finding-summary"))?.data).toMatchObject({ completed: true });
	});

	test("an inline BLOCKED missing-prerequisite result names new_dependency", async () => {
		const h = await subagentHarness({ units: [U1] });
		await h.start("U1");
		const packet = await h.call("subagent_packet", { role: "implementer", unit: "U1" });
		const result = done({ status: "BLOCKED", reason: "missing-prerequisite", evidence: "needs a <token> store", commits: [], sources_used: footerIds(textOf(packet)) });
		const out = textOf(await h.call("subagent_record", { role: "implementer", unit: "U1", result }));
		expect(out).toContain("new_dependency U1");
		expect(out).toContain("<untrusted>needs a &lt;token> store</untrusted>");
		expect((await h.ofKind("decision")).filter((m) => m.id.startsWith("progress."))).toEqual([]);
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

describe("verifier", () => {
	const AGGREGATE = {
		role: "reviewer", subject: "change", round: 1, status: "DONE", advisory: false, head: "h1", packet: "p", sources_used: [], required: [], completed: true,
		agentSource: "s", requested: { thinking: "low" }, effective: {}, aggregate: true, reviews: ["c0"],
		findings: [{ ...FINDING, location: "src/free.ts:4", scope: "in-change", from: ["c0"], needsDecision: false, route: "in-change", verify: "required" }],
	};
	const seeded = async () => {
		const h = await subagentHarness({ units: [U1] });
		await h.seed("finding-summary", "finding-summary.change.review.1", AGGREGATE);
		const key = `${(await h.latest("finding-summary"))?.ref}:0`;
		return { h, key };
	};
	const verdict = (over: Record<string, unknown> = {}) => ({ status: "DONE", notes: "n", discoveries: [], sources_used: [], findings: [], verdict: "refuted", reason: "guarded by caller", ...over });

	test("Verifier recorded", async () => {
		const { h, key } = await seeded();
		const cited = footerIds(textOf(await h.call("subagent_packet", { role: "verifier", finding: key })));
		const out = await h.call("subagent_record", { role: "verifier", finding: key, result: verdict({ sources_used: cited }) });
		expect(out.isError, textOf(out)).toBeFalsy();
		const record = (await h.ofKind("finding-summary")).find((m) => m.id.startsWith("finding-summary.verify."));
		expect(record?.id).toBe(`finding-summary.verify.${key.replace(/[^A-Za-z0-9._-]/g, "-")}.1`);
		expect(record?.data).toMatchObject({ role: "verifier", verifies: key, verdict: "refuted", reason: "guarded by caller" });
	});

	test("Verifier of an in-change finding: packet builds with the finding and code", async () => {
		const { h, key } = await seeded();
		const packet = textOf(await h.call("subagent_packet", { role: "verifier", finding: key }));
		expect(packet).toContain("off by one");
		expect(packet).not.toContain("refused");
	});

	test("Verifier without a finding, an ignored finding for another role, an unknown key", async () => {
		const { h, key } = await seeded();
		const before = (await h.marked()).length;
		for (const tool of ["subagent_dispatch", "subagent_packet"]) {
			const none = await h.call(tool, { role: "verifier" });
			expect(none.isError).toBe(true);
			expect(textOf(none)).toContain("finding reference");
		}
		const unknown = await h.call("subagent_dispatch", { role: "verifier", finding: "c999:0" });
		expect(unknown.isError).toBe(true);
		expect(textOf(unknown)).toContain("names no aggregate finding");
		const rec = await h.call("subagent_record", { role: "verifier", finding: "c999:0", result: verdict() });
		expect(textOf(rec)).toContain("names no aggregate finding");
		expect(await h.marked()).toHaveLength(before);
		const other = await h.call("subagent_dispatch", { role: "implementer", unit: "U1", finding: key });
		expect(other.isError).toBeFalsy();
		expect(textOf(other)).toMatch(/^Warning: ignored finding/);
	});

	test("Verifier without a verdict is refused on record", async () => {
		const { h, key } = await seeded();
		const out = await h.call("subagent_record", { role: "verifier", finding: key, result: verdict({ verdict: undefined }) });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("verdict is required");
	});
});
