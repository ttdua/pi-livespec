// Tests of the dispatch core: spawn options, the post-launch check, result interpretation and the orchestration order.
import { afterEach, describe, expect, test } from "vitest";
import { parseMarked } from "../../src/forge/markers.ts";
import { type DispatchDeps, type DispatchRequest, runDispatch } from "../../src/subagents/dispatch.ts";
import { checkLaunch, raisedThinking, spawnOptions } from "../../src/subagents/launch.ts";
import { interpret } from "../../src/subagents/result.ts";
import { needsContextCount, nextAttempt, nextRound } from "../../src/subagents/run-record.ts";
import { current, dispatchComment, findingSummaryComment, latestDispatch } from "../../src/subagents/records.ts";
import { mark } from "./helpers.ts";
import { isDispatchData } from "../../src/subagents/validate.ts";
import { checkSchema, resultSchema } from "../../src/subagents/roles.ts";
import type { Packet } from "../../src/subagents/source-types.ts";
import { applied, done, fakeExecutor, unpublish } from "./fake-executor.ts";

afterEach(unpublish);

const packet = (over: Partial<Packet> = {}): Packet => ({
	text: "PACKET", hash: "a".repeat(64), sources: [{ id: "answer:Q2", version: "v", required: true }, { id: "spec:x", version: "v", required: false }],
	skillPaths: ["/tree/skills/tdd/SKILL.md"], cwd: "/w/c", seen: [], ...over,
});

const request = (over: Partial<DispatchRequest> = {}): DispatchRequest => ({
	role: "implementer", unit: "U1", packet: packet(), change: "c", difficulty: "low", failedAttempts: 0, exclusions: [], attempt: 1, round: 1, needsContext: 0, ...over,
});

function deps(fake: ReturnType<typeof fakeExecutor>) {
	const posted: { kind: string; data: Record<string, unknown> }[] = [];
	const warnings: string[] = [];
	const d: DispatchDeps = {
		service: fake.service,
		events: fake.events,
		post: async (body) => {
			const m = parseMarked(body);
			if (m) posted.push({ kind: m.kind, data: m.data as Record<string, unknown> });
		},
		headOf: async () => "h".repeat(40),
		reachable: async (_cwd, commits) => commits.filter((c) => c !== "unreachable"),
		onOverride: (a) => warnings.push(a.name),
	};
	return { d, posted, warnings };
}

const withSources = (ids: string[]) => done({ sources_used: ids });

describe("launch options", () => {
	test("implementer launch options", () => {
		const o = spawnOptions(packet({ cwd: "/w/c" }), "implementer", undefined, "medium", 0, ["git:github.com/obra/superpowers"], { change: "c", unit: "U3" });
		expect(o).toMatchObject({ context: "fresh", contextFiles: false, skills: { inherit: false, paths: ["/tree/skills/tdd/SKILL.md"] }, cwd: "/w/c", thinkingLevel: "medium" });
		expect(o.metadata).toEqual({ owner: "livespec", change: "c", role: "implementer", packet: "a".repeat(64), unit: "U3", difficulty: "medium" });
		expect(o.resultSchema).toEqual(resultSchema("implementer"));
		expect(o).not.toHaveProperty("model");
	});

	test("raised after a failure", () => {
		expect(raisedThinking("low", 1)).toBe("medium");
		expect(raisedThinking("medium", 5)).toBe("high");
		expect(raisedThinking("low", 0)).toBe("low");
	});

	test.each([
		["context", { context: "fork" }],
		["cwd", { cwd: "/elsewhere" }],
		["inheritSkills", { inheritSkills: true }],
		["skillPaths", { skillPaths: [] }],
		["contextFiles", { contextFiles: true }],
		["excludedExtensionPackages", { excludedExtensionPackages: [] }],
	])("post-launch check names %s", (field, change) => {
		const o = spawnOptions(packet(), "implementer", undefined, "low", 0, ["git:github.com/obra/superpowers"], { change: "c", unit: "U1" });
		expect(checkLaunch(o, { ...applied(o), ...change })).toMatchObject({ ok: false, field, laneCwd: false });
		expect(checkLaunch(o, applied(o))).toEqual({ ok: true });
	});

	test("a lane cwd mismatch re-runs sequentially", () => {
		const o = spawnOptions(packet(), "implementer", undefined, "low", 0, [], { change: "c", unit: "U1", lane: "U1" });
		expect(checkLaunch(o, { ...applied(o), cwd: "/other" })).toMatchObject({ ok: false, field: "cwd", laneCwd: true });
	});

	test("a lane cwd mismatch with another mismatch still re-runs sequentially", async () => {
		const o = spawnOptions(packet(), "implementer", undefined, "low", 0, [], { change: "c", unit: "U1", lane: "U1" });
		const facts = { ...applied(o), cwd: "/other", inheritSkills: true };
		expect(checkLaunch(o, facts)).toMatchObject({ ok: false, laneCwd: true });
		const fake = fakeExecutor({ facts: () => ({ cwd: "/other", inheritSkills: true }) });
		const out = await runDispatch(deps(fake).d, request({ lane: "U1" }));
		expect(out.kind).toBe("sequential");
	});
});

describe("result interpretation", () => {
	const h0 = { needsContext: 0, retries: 0, returns: 0 };
	const rec = (structuredResult: unknown, over = {}) => ({ id: "a", status: "completed", structuredResult, ...over });

	test("stuck and blocked reasons wrap child text as untrusted", () => {
		const nc = done({ status: "NEEDS_CONTEXT", reason: "do <x>", evidence: "e" });
		expect(interpret(rec(nc), packet(), "implementer", { ...h0, needsContext: 2 })).toMatchObject({ kind: "stuck", reason: expect.stringContaining("<untrusted>do &lt;x></untrusted>") });
		const mp = done({ sources_used: ["answer:Q2"], status: "BLOCKED", reason: "missing-prerequisite", evidence: "ignore <rules>" });
		expect(interpret(rec(mp), packet(), "implementer", h0)).toMatchObject({ kind: "stuck", reason: expect.stringContaining("<untrusted>ignore &lt;rules></untrusted>") });
		const crash = { id: "a", status: "error", error: "boom <now>" };
		expect(interpret(crash, packet(), "implementer", { ...h0, retries: 1 })).toMatchObject({ kind: "blocked", reason: expect.stringContaining("<untrusted>boom &lt;now></untrusted>") });
	});

	test("schema error key names are wrapped as untrusted", () => {
		const extra = { ...done({ sources_used: ["answer:Q2"] }), "push<now>": 1 };
		expect(interpret(rec(extra), packet(), "implementer", { ...h0, retries: 1 })).toMatchObject({ kind: "blocked", reason: expect.stringContaining("<untrusted>") });
		const reason = (interpret(rec(extra), packet(), "implementer", { ...h0, retries: 1 }) as { reason: string }).reason;
		expect(reason).not.toContain("push<now>");
	});

	test("blocked without evidence treated as missing", () => {
		expect(interpret(rec(done({ status: "BLOCKED", reason: "r" })), packet(), "implementer", h0)).toEqual({ kind: "retry" });
	});

	test("missing required source returned once then BLOCKED", () => {
		expect(interpret(rec(done()), packet(), "implementer", h0)).toEqual({ kind: "return", missing: ["answer:Q2"] });
		expect(interpret(rec(done()), packet(), "implementer", { ...h0, returns: 1 }).kind).toBe("blocked");
	});

	test("needs context capped at 2", () => {
		const nc = done({ status: "NEEDS_CONTEXT", reason: "need spec:auth", evidence: "no auth spec" });
		expect(interpret(rec(nc), packet(), "implementer", { ...h0, needsContext: 1 })).toMatchObject({ kind: "more-context", ids: ["spec:auth"] });
		expect(interpret(rec(nc), packet(), "implementer", { ...h0, needsContext: 2 }).kind).toBe("stuck");
	});

	test("missing-prerequisite goes to spec_stuck", () => {
		const b = withSources(["answer:Q2"]);
		expect(interpret(rec({ ...b, status: "BLOCKED", reason: "missing-prerequisite", evidence: "U0 not merged" }), packet(), "implementer", h0).kind).toBe("stuck");
	});

	test("a crash is retried once, then blocked", () => {
		expect(interpret({ id: "a", status: "error", error: "boom" }, packet(), "implementer", h0)).toEqual({ kind: "retry" });
		expect(interpret({ id: "a", status: "error", error: "boom" }, packet(), "implementer", { ...h0, retries: 1 }).kind).toBe("blocked");
	});

	test("subset validator rejects extra keys and bad enums", () => {
		expect(checkSchema(resultSchema("scout"), { ...done(), commits: undefined, extra: 1 }).ok).toBe(false);
		expect(checkSchema(resultSchema("implementer"), done({ status: "MAYBE" })).ok).toBe(false);
		expect(checkSchema(resultSchema("implementer"), done()).ok).toBe(true);
	});
});

describe("records", () => {
	const base = { role: "implementer" as const, unit: "U1", attempt: 1, packet: "p", agentSource: "s", requested: { thinking: "low" as const }, effective: {}, commits: [], notes: "", discoveries: [], sources_used: [] };
	const rec = (over: Record<string, unknown>) => mark(dispatchComment({ ...base, status: "DONE", ...over } as never));

	test("needsContextCount counts NEEDS_CONTEXT dispatch records of the unit and role only", () => {
		const marked = [
			rec({ status: "NEEDS_CONTEXT", contextRequest: 1 }), rec({ status: "DONE" }), rec({ unit: "U2", status: "NEEDS_CONTEXT", contextRequest: 1 }),
			rec({ status: "NEEDS_CONTEXT", contextRequest: 2 }), rec({ role: "scout", status: "NEEDS_CONTEXT", contextRequest: 1 }),
		];
		expect(needsContextCount(marked, "U1", "implementer")).toBe(2);
		expect(needsContextCount(marked, "U2", "implementer")).toBe(1);
		expect(needsContextCount(marked, "U1", "scout")).toBe(1);
	});

	test("a launch-mismatch record does not supersede the run of the same attempt", () => {
		const mismatch = rec({ status: "BLOCKED", reason: "launch-mismatch", evidence: "cwd", launchMismatch: true });
		const run = rec({ status: "DONE" });
		expect(mismatch.id).not.toBe(run.id);
		expect(current([mismatch, run])).toEqual([mismatch, run]);
		expect(nextAttempt([mismatch], "implementer", "U1")).toBe(1);
	});

	test("launchMismatch is valid only as true", () => {
		expect(isDispatchData({ ...base, status: "BLOCKED", launchMismatch: true })).toBe(true);
		expect(isDispatchData({ ...base, status: "BLOCKED", launchMismatch: false })).toBe(false);
	});

	test("a child's own launch-mismatch reason is a normal BLOCKED run", () => {
		const child = rec({ status: "BLOCKED", reason: "launch-mismatch", evidence: "the child says so" });
		expect(child.id).toBe("dispatch.U1.implementer.1");
		expect(nextAttempt([child], "implementer", "U1")).toBe(2);
		expect(latestDispatch([child], "U1")).toBeDefined();
	});

	test("latestDispatch ignores launch-mismatch records", () => {
		const run = rec({ status: "DONE", discoveries: ["d"] });
		const mismatch = rec({ attempt: 2, status: "BLOCKED", reason: "launch-mismatch", evidence: "cwd", launchMismatch: true });
		expect(latestDispatch([run, mismatch], "U1")?.status).toBe("DONE");
	});

	test("review NEEDS_CONTEXT summaries count toward the cap, not toward rounds", () => {
		const summary = (over: Record<string, unknown>) => mark(findingSummaryComment({
			role: "reviewer", subject: "unit", unit: "U1", round: 1, status: "DONE", advisory: false, head: "h", packet: "p", sources_used: [], required: [], completed: true,
			agentSource: "s", requested: { thinking: "low" }, effective: {}, findings: [], ...over,
		} as never));
		const nc1 = summary({ status: "NEEDS_CONTEXT", completed: false, contextRequest: 1 });
		const nc2 = summary({ status: "NEEDS_CONTEXT", completed: false, contextRequest: 2 });
		expect(nc1.id).not.toBe(nc2.id);
		expect(needsContextCount([nc1, nc2], "U1", "reviewer")).toBe(2);
		expect(needsContextCount([nc1, nc2], "U1", "implementer")).toBe(0);
		expect(nextRound([nc1, nc2], "reviewer", "U1", "unit")).toBe(1);
		expect(current([nc1, nc2, summary({})])).toHaveLength(3);
	});

	test("NEEDS_CONTEXT records do not raise the attempt and are not superseded by the next run", () => {
		const nc = rec({ status: "NEEDS_CONTEXT", reason: "r", evidence: "e", contextRequest: 1 });
		expect(nextAttempt([nc], "implementer", "U1")).toBe(1);
		const next = rec({ status: "DONE" });
		expect(current([nc, next])).toEqual([nc, next]);
		expect(needsContextCount([nc, next], "U1", "implementer")).toBe(1);
	});
});

describe("runDispatch", () => {
	test("capable executor launches", async () => {
		const fake = fakeExecutor({ records: [{ structuredResult: withSources(["answer:Q2"]) }] });
		const { d, posted } = deps(fake);
		const out = await runDispatch(d, request());
		expect(out.kind).toBe("result");
		expect(fake.spawned).toHaveLength(1);
		expect(fake.spawned[0]?.type).toBe("implementer");
		expect(posted.map((p) => p.kind)).toEqual(["dispatch"]);
		expect(posted[0]?.data).toMatchObject({ agentId: "agent-1", status: "DONE", agentSource: "builtin", requested: { thinking: "low" } });
	});

	test("session-created emitted during spawn is not missed", async () => {
		const fake = fakeExecutor({ emitDuringSpawn: true, records: [{ structuredResult: withSources(["answer:Q2"]) }] });
		expect((await runDispatch(deps(fake).d, request())).kind).toBe("result");
	});

	test("dispatch treats a missing session-created as a mismatch", async () => {
		const fake = fakeExecutor({ facts: () => null, records: [{ structuredResult: withSources(["answer:Q2"]) }] });
		const { d, posted } = deps(fake);
		const out = await runDispatch(d, request());
		expect(out).toMatchObject({ kind: "inline" });
		expect(out.kind === "inline" && out.reason).toContain("session-created");
		expect(fake.aborted).toEqual(["agent-1"]);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.kind).toBe("dispatch");
		expect(posted[0]?.data).toMatchObject({ status: "BLOCKED", agentId: "agent-1", attempt: 1 });
		expect(String(posted[0]?.data.notes)).toContain("launch-mismatch");
		expect(String(posted[0]?.data.notes)).toContain("session-created");
	});

	test("a field mismatch is recorded with requested and effective values", async () => {
		const fake = fakeExecutor({ facts: () => ({ inheritSkills: true }) });
		const { d, posted } = deps(fake);
		await runDispatch(d, request());
		expect(posted[0]?.data).toMatchObject({ status: "BLOCKED", attempt: 1 });
		expect(String(posted[0]?.data.notes)).toMatch(/inheritSkills: requested false, effective true/);
	});

	test("a lane cwd mismatch is recorded and re-runs sequentially", async () => {
		const fake = fakeExecutor({ facts: () => ({ cwd: "/moved" }) });
		const { d, posted } = deps(fake);
		const out = await runDispatch(d, request({ lane: "U1" }));
		expect(out.kind).toBe("sequential");
		expect(String(posted[0]?.data.notes)).toMatch(/cwd: requested \/w\/c, effective \/moved/);
	});

	test("a reviewer mismatch posts a dispatch record, not a finding-summary", async () => {
		const fake = fakeExecutor({ facts: () => ({ inheritSkills: true }) });
		const { d, posted } = deps(fake);
		const out = await runDispatch(d, request({ role: "reviewer", subject: "unit" }));
		expect(out.kind).toBe("inline");
		expect(posted.map((p) => p.kind)).toEqual(["dispatch"]);
		expect(posted[0]?.data).toMatchObject({ role: "reviewer", subject: "unit", status: "BLOCKED", reason: "launch-mismatch", launchMismatch: true });
		expect(String(posted[0]?.data.evidence)).toContain("inheritSkills: requested false, effective true");
		const marked = posted.map((p) => mark(dispatchComment(p.data as never)));
		expect(nextRound(marked, "reviewer", "U1", "unit")).toBe(1);
	});

	test("a rejected wait is retried as a crash", async () => {
		const fake = fakeExecutor({ records: [{ structuredResult: withSources(["answer:Q2"]) }] });
		let calls = 0;
		const wait = fake.service.wait;
		fake.service.wait = async (id: string) => {
			if (++calls === 1) throw new Error("executor lost the run");
			return wait(id);
		};
		const { d } = deps(fake);
		const out = await runDispatch(d, request());
		expect(fake.spawned).toHaveLength(2);
		expect(out.kind).toBe("result");
	});

	test("skills ignored aborts", async () => {
		const fake = fakeExecutor({ facts: () => ({ inheritSkills: true }) });
		const out = await runDispatch(deps(fake).d, request());
		expect(out.kind === "inline" && out.reason).toContain("inheritSkills");
		expect(fake.aborted).toEqual(["agent-1"]);
	});

	test("exclusion ignored aborts", async () => {
		const fake = fakeExecutor({ facts: () => ({ excludedExtensionPackages: [] }) });
		const out = await runDispatch(deps(fake).d, request({ exclusions: ["git:github.com/obra/superpowers"] }));
		expect(out.kind === "inline" && out.reason).toContain("excludedExtensionPackages");
		expect(fake.aborted).toEqual(["agent-1"]);
	});

	test("context forced to fork returns refusal", async () => {
		const fake = fakeExecutor({ spawnError: "agent implementer locks context: fork" });
		const out = await runDispatch(deps(fake).d, request());
		expect(out.kind).toBe("inline");
		expect(out.kind === "inline" && out.reason).toContain("locks context: fork");
	});

	test("disabled role agent runs inline", async () => {
		const fake = fakeExecutor({ agent: null });
		const out = await runDispatch(deps(fake).d, request({ role: "reviewer", subject: "unit" }));
		expect(out.kind === "inline" && out.reason).toContain("disabled");
		expect(fake.spawned).toEqual([]);
	});

	test("user override used with one warning", async () => {
		const agent = { name: "implementer", source: "global", filePath: "/home/u/.pi/agent/agents/implementer.md" };
		const fake = fakeExecutor({ agent, records: [{ structuredResult: withSources(["answer:Q2"]) }] });
		const { d, posted, warnings } = deps(fake);
		await runDispatch(d, request());
		expect(warnings).toEqual(["implementer"]);
		expect(posted[0]?.data.agentSource).toBe("global");
	});

	test("routed by another layer recorded", async () => {
		const fake = fakeExecutor({ facts: () => ({ effectiveThinking: "high", effectiveModel: "p/m" }), records: [{ structuredResult: withSources(["answer:Q2"]) }] });
		const { d, posted } = deps(fake);
		await runDispatch(d, request());
		expect(posted[0]?.data).toMatchObject({ requested: { thinking: "low" }, effective: { thinking: "high", model: "p/m" } });
	});

	test("crash retried once with identical hash", async () => {
		const fake = fakeExecutor({ records: [{ status: "error", error: "boom" }, { status: "error", error: "boom" }] });
		const { d, posted } = deps(fake);
		const out = await runDispatch(d, request());
		expect(fake.spawned).toHaveLength(2);
		expect(fake.spawned[0]?.options.metadata.packet).toBe(fake.spawned[1]?.options.metadata.packet);
		expect(fake.spawned[0]?.prompt).toBe(fake.spawned[1]?.prompt);
		expect(out.kind).toBe("blocked");
		expect(posted[0]?.data.status).toBe("BLOCKED");
	});

	test("missing required source resumed once naming it, then BLOCKED", async () => {
		const fake = fakeExecutor({ records: [{ structuredResult: done() }, { structuredResult: done() }] });
		const { d } = deps(fake);
		const out = await runDispatch(d, request());
		expect(fake.resumed).toHaveLength(1);
		expect(fake.resumed[0]?.prompt).toContain("answer:Q2");
		expect(out.kind).toBe("blocked");
	});

	test("ask posts a QUESTION record with the agent id", async () => {
		const fake = fakeExecutor({ records: [{ pendingQuestion: { text: "Which config file?" } }] });
		const { d, posted } = deps(fake);
		const out = await runDispatch(d, request());
		expect(out).toEqual({ kind: "question", id: "agent-1", text: "Which config file?" });
		expect(posted[0]?.data).toMatchObject({ status: "QUESTION", agentId: "agent-1", question: "Which config file?" });
	});

	test("unreachable commits are not counted", async () => {
		const fake = fakeExecutor({ records: [{ structuredResult: done({ sources_used: ["answer:Q2"], commits: ["abc", "unreachable"] }) }] });
		const { d, posted } = deps(fake);
		await runDispatch(d, request());
		expect(posted[0]?.data.commits).toEqual(["abc"]);
	});

	test("reviewer run posts a finding-summary", async () => {
		const result = { ...withSources(["answer:Q2"]), commits: undefined, findings: [{ severity: "WARNING", kind: "defect", location: "a.ts:1", evidence: "e", fix: "f", scope: "unit" }] };
		const fake = fakeExecutor({ records: [{ structuredResult: JSON.parse(JSON.stringify(result)) }] });
		const { d, posted } = deps(fake);
		await runDispatch(d, request({ role: "reviewer", subject: "unit" }));
		expect(posted[0]?.kind).toBe("finding-summary");
		expect(posted[0]?.data).toMatchObject({ agentId: "agent-1", round: 1, completed: true, required: ["answer:Q2"], head: "h".repeat(40) });
	});

	test("a unit review posts one finding-summary holding both findings", async () => {
		const found = (location: string) => ({ severity: "WARNING", kind: "defect", location, evidence: "e", fix: "f", scope: "unit" });
		const result = { ...withSources(["answer:Q2"]), commits: undefined, findings: [found("a.ts:1"), found("b.ts:2")] };
		const fake = fakeExecutor({ records: [{ structuredResult: JSON.parse(JSON.stringify(result)) }] });
		const { d, posted } = deps(fake);
		await runDispatch(d, request({ role: "reviewer", subject: "unit" }));
		expect(posted.filter((p) => p.kind === "finding-summary")).toHaveLength(1);
		expect(posted[0]?.data).toMatchObject({ unit: "U1", round: 1 });
		expect((posted[0]?.data.findings as { location: string }[]).map((f) => f.location)).toEqual(["a.ts:1", "b.ts:2"]);
	});
});
