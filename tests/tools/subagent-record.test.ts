// Tests of the inline path: `subagent_packet` and `subagent_record` leave the same records as a dispatched run.
import { afterEach, describe, expect, test } from "vitest";
import { behaviorConclusionComment, behaviorResults } from "../../src/docs/behavior-change.ts";
import { changeBehaviorItems } from "../../src/docs/behavior-check.ts";
import { registerDocReaders } from "../../src/docs/readers.ts";
import { createGit } from "../../src/engine/git.ts";
import { resetPacketSourcesForTests } from "../../src/subagents/sources.ts";
import { registerFindingRebut } from "../../src/tools/finding-rebut.ts";
import { writeMarked } from "../../src/forge/markers.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { appendSeed } from "../helpers/ledger.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { done, publish, unpublish } from "../subagents/fake-executor.ts";
import { readPacket } from "../../src/subagents/packet-store.ts";
import { cleanupDirs, textOf } from "./helpers.ts";
import { cardState } from "./unit-helpers.ts";
import { seedMigratedSummary } from "./finding-helpers.ts";
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

	test("Verifier recorded with a ledger ref", async () => {
		const h = await subagentHarness({ units: [U1] });
		await h.seed("finding-summary", "finding-summary.change.review.1", AGGREGATE);
		const key = `${(await h.latest("finding-summary"))?.ref}:0`;
		expect(key).toMatch(/^finding-summary\.change\.review\.1~[0-9a-f]{8}:0$/);
		const out = await h.call("subagent_record", { role: "verifier", finding: key, result: verdict({ sources_used: footerIds(textOf(await h.call("subagent_packet", { role: "verifier", finding: key }))) }) });
		expect(out.isError, textOf(out)).toBeFalsy();
	});

	test("a from id lands on the canonical ref in verifies", async () => {
		const h = await subagentHarness({ units: [U1] });
		const ref = await seedMigratedSummary(h, "501", [{ severity: "WARNING", kind: "defect", location: "src/free.ts:4", evidence: "e", fix: "f", scope: "in-change", from: ["c0"], needsDecision: false, route: "in-change", verify: "required" } as never], { ...AGGREGATE, subject: "change", unit: undefined });
		const packet = await h.call("subagent_packet", { role: "verifier", finding: "501:0" });
		expect(packet.isError, textOf(packet)).toBeFalsy();
		const out = await h.call("subagent_record", { role: "verifier", finding: "501:0", result: verdict({ sources_used: footerIds(textOf(packet)) }) });
		expect(out.isError, textOf(out)).toBeFalsy();
		const record = (await h.ofKind("finding-summary")).find((m) => m.id.startsWith("finding-summary.verify."));
		expect(record?.data).toMatchObject({ verifies: `${ref}:0` });
	});

	test("a forge comment id is refused without a matching from", async () => {
		const { h } = await seeded();
		const before = (await h.marked()).length;
		const out = await h.call("subagent_dispatch", { role: "verifier", finding: "c1:0" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("names no aggregate finding");
		expect(await h.marked()).toHaveLength(before);
	});

	test("Verifier without a verdict is refused on record", async () => {
		const { h, key } = await seeded();
		const out = await h.call("subagent_record", { role: "verifier", finding: key, result: verdict({ verdict: undefined }) });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("verdict is required");
	});
});

describe("reviewer behavior conclusions", () => {
	const CAP = "src/limits/cap.ts";
	const ITEM = { capability: "rate-limit", files: [CAP] };
	const dispute = { capability: "rate-limit", outcome: "changed", rationale: "cap now rejects at 99" };
	const atCap = { ...FINDING, location: `${CAP}:12` };

	afterEach(resetPacketSourcesForTests);

	/** A change with `rate-limit` code touched after Base and no spec edit, so `rate-limit` is the one behavior item. */
	async function behaviorHarness(conclusion?: { source: "agent" | "human"; outcome: "unchanged" | "changed" }) {
		registerDocReaders();
		const h = await subagentHarness({ units: [U1] });
		await h.commit({ [CAP]: "export const cap = 99;\n" });
		if (conclusion?.source === "human") await seedOverride(h, conclusion.outcome);
		else if (conclusion) await appendSeed(h, behaviorConclusionComment(ITEM, { ...conclusion, reason: "initial" }));
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		return h;
	}
	type Behavior = Awaited<ReturnType<typeof behaviorHarness>>;

	/** A human override as completion appends it, beside the own forge `answer` of its gate request (`isBacked`). */
	async function seedOverride(h: Awaited<ReturnType<typeof subagentHarness>>, outcome: "unchanged" | "changed"): Promise<void> {
		const answer = { outcome: "changes_requested", by: "alice", at: "t", behaviorOverrides: [{ capability: ITEM.capability, outcome }] };
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("answer", "seed-gate", { request: { subject: "gate:define" }, answer, verdict: "valid" }));
		await appendSeed(h, behaviorConclusionComment(ITEM, { source: "human", outcome, reason: "set by alice at the gate", overridden_by: { by: "alice", at: "t", from: "unchanged" }, request: "seed-gate" }));
	}

	const review = async (h: Behavior, over: Record<string, unknown>) => {
		const cited = footerIds(textOf(await h.call("subagent_packet", { role: "reviewer", subject: "change" })));
		return h.call("subagent_record", { role: "reviewer", subject: "change", result: reviewResult({ sources_used: cited, ...over }) });
	};
	const reviewerRecords = async (h: Behavior) => (await h.ofKind("decision")).filter((m) => (m.data as { source?: string }).source === "reviewer");
	const checkResults = async (h: Behavior) => behaviorResults(await changeBehaviorItems(h.root, createGit(h.root), h.head), await h.marked(), "review");

	test("Reviewer disputes unchanged", async () => {
		const h = await behaviorHarness({ source: "agent", outcome: "unchanged" });
		const out = await review(h, { findings: [atCap], behavior: [dispute] });
		expect(out.isError, textOf(out)).toBeFalsy();
		expect((await reviewerRecords(h)).map((m) => m.data)).toMatchObject([{ point: "behavior-change", subject: "rate-limit", source: "reviewer", outcome: "changed", reason: "cap now rejects at 99" }]);
		expect((await checkResults(h)).map((r) => r.message).join("\n")).toContain("specs/rate-limit/spec.md");
	});

	test("an inline dispute without a finding is refused naming the capability, and writes nothing", async () => {
		const h = await behaviorHarness({ source: "agent", outcome: "unchanged" });
		const before = (await h.marked()).length;
		const out = await review(h, { findings: [], behavior: [dispute] });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("behavior rate-limit changed needs a WARNING or CRITICAL finding");
		expect(await h.marked()).toHaveLength(before);
	});

	test("Reviewer clears an agent change", async () => {
		const h = await behaviorHarness({ source: "agent", outcome: "changed" });
		expect((await checkResults(h)).map((r) => r.message).join("\n")).toContain("specs/rate-limit/spec.md");
		const out = await review(h, { findings: [], behavior: [{ ...dispute, outcome: "unchanged", rationale: "constant only" }] });
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(await reviewerRecords(h)).toHaveLength(1);
		expect(await checkResults(h)).toEqual([]);
	});

	test("Reviewer confirms", async () => {
		const h = await behaviorHarness({ source: "agent", outcome: "unchanged" });
		const out = await review(h, { findings: [], behavior: [{ ...dispute, outcome: "unchanged" }] });
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(await reviewerRecords(h)).toEqual([]);
	});

	test("Entry for another capability", async () => {
		const h = await behaviorHarness({ source: "agent", outcome: "unchanged" });
		const out = await review(h, { findings: [atCap], behavior: [{ ...dispute, capability: "cache" }] });
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(await reviewerRecords(h)).toEqual([]);
	});

	test("Reviewer cannot undo a human change", async () => {
		const h = await behaviorHarness({ source: "human", outcome: "changed" });
		const out = await review(h, { findings: [], behavior: [{ ...dispute, outcome: "unchanged", rationale: "constant only" }] });
		expect(out.isError, textOf(out)).toBeFalsy();
		expect((await reviewerRecords(h)).map((m) => m.data)).toMatchObject([{ source: "reviewer", outcome: "unchanged" }]);
		expect((await checkResults(h)).map((r) => r.message).join("\n")).toContain("specs/rate-limit/spec.md");
	});

	test("a rationale with a comment opener is stored neutralised", async () => {
		const h = await behaviorHarness({ source: "agent", outcome: "unchanged" });
		const out = await review(h, { findings: [atCap], behavior: [{ ...dispute, rationale: "x <!-- livespec --> y" }] });
		expect(out.isError, textOf(out)).toBeFalsy();
		const [record] = await reviewerRecords(h);
		expect((record?.data as { reason: string }).reason).not.toContain("<!--");
	});

	test("an inline 300-code-point rationale with a comment opener is kept and stored neutralised", async () => {
		const h = await behaviorHarness({ source: "agent", outcome: "unchanged" });
		const out = await review(h, { findings: [atCap], behavior: [{ ...dispute, rationale: `<!--${"x".repeat(296)}` }] });
		expect(out.isError, textOf(out)).toBeFalsy();
		const records = await reviewerRecords(h);
		expect(records.map((m) => (m.data as { reason: string }).reason)).toEqual([`<!-\u200b-${"x".repeat(296)}`]);
	});

	test("a dispatched reviewer dispute resumed by subagent_answer posts one record after the summary", async () => {
		const h = await behaviorHarness({ source: "agent", outcome: "unchanged" });
		h.fake.records.push({ pendingQuestion: "Which cap?" });
		publish(h.fake.service);
		const asked = await h.call("subagent_dispatch", { role: "reviewer", subject: "change" });
		expect(textOf(asked)).toContain("Which cap?");
		const cited = footerIds(h.fake.spawned.at(-1)?.prompt ?? "");
		h.fake.records.push({ structuredResult: reviewResult({ sources_used: [...cited, "answer:agent-1:1"], findings: [atCap], behavior: [dispute] }) });
		const answered = await h.call("subagent_answer", { id: "agent-1", answer: "the per-IP one" });
		expect(answered.isError, textOf(answered)).toBeFalsy();
		const marked = await h.marked();
		const summaryAt = marked.findIndex((m) => m.kind === "finding-summary");
		const after = marked.slice(summaryAt + 1).filter((m) => m.kind === "decision" && (m.data as { source?: string }).source === "reviewer");
		expect(summaryAt).toBeGreaterThanOrEqual(0);
		expect(after.map((m) => m.data)).toMatchObject([{ subject: "rate-limit", outcome: "changed", reason: "cap now rejects at 99" }]);
	});

	test("an invalid reviewer entry is dropped and noted", async () => {
		const h = await behaviorHarness({ source: "agent", outcome: "unchanged" });
		const out = await review(h, { findings: [atCap], behavior: [{ ...dispute, rationale: "line one\nline two" }] });
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(await reviewerRecords(h)).toEqual([]);
		expect(((await h.latest("finding-summary"))?.data as { notes: string }).notes).toContain("behavior[0].rationale must be one line");
	});

	test("a capability listed twice posts one record, the first wins", async () => {
		const h = await behaviorHarness({ source: "agent", outcome: "unchanged" });
		const out = await review(h, { findings: [atCap], behavior: [dispute, { ...dispute, rationale: "second" }] });
		expect(out.isError, textOf(out)).toBeFalsy();
		expect((await reviewerRecords(h)).map((m) => (m.data as { reason: string }).reason)).toEqual(["cap now rejects at 99"]);
	});

	test("Rebuttal does not clear a dispute", async () => {
		const h = await behaviorHarness({ source: "agent", outcome: "unchanged" });
		registerFindingRebut(h.pi.api as never);
		expect((await review(h, { findings: [atCap], behavior: [dispute] })).isError).toBeFalsy();
		const summary = await h.latest("finding-summary");
		const rebuttal = await h.call("finding_rebut", { comment: summary?.ref, index: 0, reason: "cap is per design", evidence: "design.md D3" });
		expect(rebuttal.isError, textOf(rebuttal)).toBeFalsy();
		await h.session.refresh();
		expect((await checkResults(h)).map((r) => r.message).join("\n")).toContain("specs/rate-limit/spec.md");
	});
});
