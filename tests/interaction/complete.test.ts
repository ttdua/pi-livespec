import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { splitLines } from "../../src/core/lines.ts";
import { renderUnit } from "../../src/core/unit-blocks.ts";
import { decisionComment, latestDecisions } from "../../src/decide/records.ts";
import { advancePhase } from "../../src/engine/advance.ts";
import { runChecks } from "../../src/engine/checks.ts";
import type { CommentsCache } from "../../src/engine/comments-cache.ts";
import { createGit } from "../../src/engine/git.ts";
import { deriveLocks, validApproval } from "../../src/engine/locks.ts";
import { nextStep } from "../../src/engine/next-step.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { readChangeSnapshot } from "../../src/engine/snapshot.ts";
import type { ChangeState } from "../../src/engine/state-types.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import { amendedBody } from "../../src/interaction/amend-body.ts";
import type { AmendSnapshot, Answered, ApprovalRequest, RequestKind, RequestRecord, RequestSnapshot } from "../../src/interaction/approver.ts";
import { type CompletionCtx, completeAnswer, finishApplying } from "../../src/interaction/complete.ts";
import { createForgeApprover } from "../../src/interaction/forge.ts";
import { prepareRequest, readRequests } from "../../src/interaction/requests.ts";
import { untrusted } from "../../src/hooks/phase-card.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN, OTHER_LOGIN } from "../forge/world.ts";
import { FIXTURE_BODY } from "../helpers/change-state.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";

const SPEC = readFileSync(new URL("../fixtures/rate-limit.spec.md", import.meta.url), "utf8");
const AT = "2026-11-15T10:00:00.000Z";
const REQUIREMENT = "rate-limit/Requirement: Per-IP cap";
const AGENT_SKILLS = "c".repeat(40);

/** The fixture with Q1 answered, `Base` set, and an optional transform. */
function bodyFor(base: string, edit: (b: string) => string = (b) => b): string {
	return edit(FIXTURE_BODY.replace("- [ ] Q1 (blocking)", "- [x] Q1 (blocking)").replace(/^Base: .*$/m, `Base: ${base}`));
}
const q1Open = (b: string) => b.replace("- [x] Q1 (blocking)", "- [ ] Q1 (blocking)");
const u3Done = (b: string) => b.replace("Verify: `npm test -- ratelimit`\n- [ ] pending", "Verify: `npm test -- ratelimit`\n- [x] done");

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(phase: string, edit?: (b: string) => string, opts: { crlf?: boolean } = {}) {
	const root = await makeRepo();
	await writeIn(root, "README.md", "x\n");
	commitAll(root);
	const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	await writeIn(root, "specs/rate-limit/spec.md", SPEC);
	commitAll(root, "spec");
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	const world = new MemoryWorld();
	const raw = bodyFor(base, edit);
	const n = await world.seedIssue({ title: "per-ip-cap", body: opts.crlf ? raw.replace(/\n/g, "\r\n") : raw, labels: ["livespec", `livespec:phase/${phase}`] });
	const loaded = await loadPack(root);
	if (!loaded.ok) throw new Error("pack");
	return { root, base, head, world, n, pack: loaded.pack, git: createGit(root) };
}

async function markedOf(f: Fixture): Promise<MarkedComment[]> {
	return filterMarked(await f.world.forge.listComments(f.n), BOT_LOGIN).comments;
}

async function ctxOf(f: Fixture, forge: Forge = f.world.forge): Promise<CompletionCtx> {
	return { forge, git: f.git, pack: f.pack, issue: f.n, marked: await markedOf(f), root: f.root, agentSkills: AGENT_SKILLS, now: () => new Date(AT) };
}

const comments = { list: async (forge: Forge, issue: { number: number }) => ({ comments: await forge.listComments(issue.number), stale: false }) } as unknown as CommentsCache;

/** The change state and next step as `Session.refresh` sees them. */
async function stateOf(f: Fixture): Promise<{ state: ChangeState; step: ReturnType<typeof nextStep> }> {
	const snapshot = await readChangeSnapshot({ forge: f.world.forge, isReadOnly: () => false, git: f.git, comments, iterationCap: f.pack.loops.change_iterations }, f.n);
	const state = { ...snapshot, checks: await runChecks(f.pack, snapshot, { root: f.root, git: f.git }) };
	return { state, step: nextStep(f.pack, state) };
}

/** `Session.refresh`: apply the derived advance once. */
async function refresh(f: Fixture): Promise<ChangeState> {
	const { step } = await stateOf(f);
	if (step.advance) await advancePhase(f.world.forge, f.n, step.advance, f.pack);
	return (await stateOf(f)).state;
}

async function prepare(f: Fixture, kind: RequestKind, subject: string, snapshot: RequestSnapshot, options?: { id: string; label: string }[]): Promise<RequestRecord> {
	const body = await f.world.bodyOf(f.n);
	return prepareRequest({ kind, subject, mode: "blocking", ...(options ? { options } : {}), head: f.head, body, snapshot, summary: `Review ${subject}`, now: new Date(AT) });
}

function envelope(record: RequestRecord): ApprovalRequest {
	return { id: record.id, kind: record.kind, subject: record.subject, record, change: 1, phase: "x", summary: record.summary, links: [], files: [], mode: record.mode, ...(record.options ? { options: record.options } : {}) };
}

const answer = (over: Partial<Answered> = {}): Answered => ({ status: "answered", outcome: "approved", notes: "", by: "alice", at: AT, adapter: "in-session", ...over });

const gateSnapshot = (target: string) => ({ target, digests: {}, failingWaivable: [] });

/** Posts the forge request, then a writer's command, and returns the polled answer. */
async function forgeAnswer(f: Fixture, record: RequestRecord, command: string): Promise<Answered> {
	const approver = createForgeApprover(f.world.forge, f.n);
	await approver.request(envelope(record));
	await f.world.setPermission("alice", "write");
	await f.world.postComment(f.n, "alice", command);
	const polled = await approver.poll(record.id);
	if (polled.status !== "answered") throw new Error("not answered");
	return polled;
}

function ofKind(marked: MarkedComment[], kind: string, id?: string): MarkedComment[] {
	return marked.filter((m) => m.kind === kind && (id === undefined || m.id === id));
}

async function seedClassification(f: Fixture): Promise<void> {
	for (const u of parseChange(await f.world.bodyOf(f.n)).units) {
		const digest = unitDigest(u);
		await f.world.postComment(f.n, BOT_LOGIN, decisionComment({ point: "tags", subject: u.id, digest, source: "rule", outcome: u.tags, reason: "rule" }));
		await f.world.postComment(f.n, BOT_LOGIN, decisionComment({ point: "difficulty", subject: u.id, digest, source: "rule", outcome: u.difficulty, reason: "rule" }));
	}
}

/** An approved plan gate locking the current units. */
async function seedLock(f: Fixture): Promise<void> {
	const locked = Object.fromEntries(parseChange(await f.world.bodyOf(f.n)).units.map((u) => [u.id, unitDigest(u)]));
	const data = { phase: "plan", outcome: "approved", notes: "", by: "alice", at: AT, adapter: "in-session", head_sha: f.head, waivers: [], locked };
	await f.world.postComment(f.n, BOT_LOGIN, writeMarked("gate", "plan.self-1", data));
}

/** A forge wrapper that throws once on the first call `failsOn` matches. */
function failingOnce(inner: Forge, failsOn: (op: string, args: unknown[]) => boolean): Forge {
	let failed = false;
	return new Proxy(inner, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (!failed && failsOn(String(prop), args)) {
					failed = true;
					throw new Error(`injected ${String(prop)} failure`);
				}
				return value.apply(target, args);
			};
		},
	});
}

const commentOfKind = (kind: string) => (op: string, args: unknown[]) => op === "createComment" && String(args[1]).startsWith(`<!-- livespec:${kind}:`);

describe("completion engine", () => {
	test("Plan gate locks digests", async () => {
		const f = await fixture("plan");
		await seedClassification(f);
		const record = await prepare(f, "gate", "gate:plan", gateSnapshot("plan"));
		const out = await completeAnswer(await ctxOf(f), record, answer());
		expect(out.status).toBe("completed");
		const gate = ofKind(await markedOf(f), "gate").at(-1)?.data as { locked: Record<string, string>; agent_skills: string };
		const units = parseChange(await f.world.bodyOf(f.n)).units;
		expect(gate.locked).toEqual({ U1: unitDigest(units[0]!), U3: unitDigest(units[1]!) });
		expect(gate.agent_skills).toBe(AGENT_SKILLS);
	});

	test("HEAD moved before the answer", async () => {
		const f = await fixture("define");
		const record = await prepare(f, "gate", "gate:define", gateSnapshot("define"));
		const polled = await forgeAnswer(f, record, "/livespec approve");
		await writeIn(f.root, "src/x.ts", "x\n");
		commitAll(f.root, "later");
		const out = await completeAnswer(await ctxOf(f), record, polled);
		expect(out.status).toBe("superseded");
		expect((ofKind(await markedOf(f), "gate").at(-1)?.data as { superseded?: boolean }).superseded).toBe(true);
		const state = await refresh(f);
		expect(state.issue.labels).toContain("livespec:phase/define");
		expect((await stateOf(f)).step.next).toContain("request the gate again");
	});

	test("Issue edited before the answer", async () => {
		const f = await fixture("define");
		const record = await prepare(f, "gate", "gate:define", gateSnapshot("define"));
		const approver = createForgeApprover(f.world.forge, f.n);
		await approver.request(envelope(record));
		await f.world.editBodyBehindBack(f.n, (await f.world.bodyOf(f.n)).replace("Limit each client IP.", "Limit each client IP and user."));
		await f.world.setPermission("alice", "write");
		await f.world.postComment(f.n, "alice", "/livespec approve");
		const polled = await approver.poll(record.id);
		if (polled.status !== "answered") throw new Error("not answered");
		const out = await completeAnswer(await ctxOf(f), record, polled);
		expect(out.status).toBe("superseded");
		expect((ofKind(await markedOf(f), "gate").at(-1)?.data as { superseded?: boolean }).superseded).toBe(true);
		expect((await refresh(f)).issue.labels).toContain("livespec:phase/define");
	});

	test("Forge approval completes", async () => {
		const f = await fixture("define");
		const record = await prepare(f, "gate", "gate:define", gateSnapshot("define"));
		const polled = await forgeAnswer(f, record, "/livespec approve");
		const out = await completeAnswer(await ctxOf(f), record, polled);
		expect(out.status).toBe("completed");
		const gate = ofKind(await markedOf(f), "gate").at(-1)?.data as { superseded?: boolean; outcome: string };
		expect(gate.outcome).toBe("approved");
		expect(gate.superseded).toBeUndefined();
		expect((await refresh(f)).issue.labels).toContain("livespec:phase/plan");
	});

	test("Forge answer recorded", async () => {
		const f = await fixture("define");
		const record = await prepare(f, "gate", "gate:define", gateSnapshot("define"));
		const polled = await forgeAnswer(f, record, "/livespec approve ship it");
		await completeAnswer(await ctxOf(f), record, polled);
		const gate = ofKind(await markedOf(f), "gate").at(-1)?.data as { adapter: string; answer_comment: { id: string; author: string; updatedAt: string } };
		expect(gate.adapter).toBe("forge");
		expect(gate.answer_comment).toMatchObject({ id: polled.answerComment?.id, author: "alice" });
	});

	test("Foreign marked gate ignored", async () => {
		const f = await fixture("plan");
		await f.world.postComment(f.n, OTHER_LOGIN, writeMarked("gate", "plan.self-1", { phase: "plan", outcome: "approved", notes: "", by: OTHER_LOGIN, at: AT, adapter: "forge", head_sha: f.head, waivers: [] }));
		const { state } = await stateOf(f);
		expect(validApproval(state.lock.gates.plan)).toBe(false);
		expect(state.warnings.some((w) => w.includes("ignored marked comment") && w.includes("gate:plan.self-1"))).toBe(true);
	});

	test("Crash while applying", async () => {
		const f = await fixture("build");
		await seedLock(f);
		const before = await f.world.bodyOf(f.n);
		const u3 = parseChange(before).units[1]!;
		const lines = renderUnit({ id: "U3", title: u3.title, covers: u3.covers, difficulty: "medium", tags: ["security", "api"], files: u3.files, done_means: u3.doneMeans, scenarios: u3.scenarios, depends: ["U1"], verify: "npm test -- ratelimit-v2" });
		const snapshot: AmendSnapshot = { action: "edit", unit: "U3", oldDigest: unitDigest(u3), oldDone: false, lines, records: [] };
		const newDigest = unitDigest(parseChange(amendedBody(before, snapshot)).units[1]!);
		snapshot.records = [
			{ point: "tags", subject: "U3", digest: newDigest, source: "rule", outcome: ["security", "api"], reason: "rule" },
			{ point: "difficulty", subject: "U3", digest: newDigest, source: "rule", outcome: "medium", reason: "rule" },
		];
		const record = await prepare(f, "gate", "amend:1", snapshot);
		const crashing = failingOnce(f.world.forge, commentOfKind("amendment"));
		await expect(completeAnswer(await ctxOf(f, crashing), record, answer())).rejects.toThrow("injected");
		expect(parseChange(await f.world.bodyOf(f.n)).units[1]?.verify).toBe("npm test -- ratelimit-v2");

		const finished = await finishApplying(await ctxOf(f));
		expect(finished.errors).toEqual([]);
		expect(finished.finished.map((c) => c.status)).toEqual(["completed"]);
		const marked = await markedOf(f);
		const amendments = ofKind(marked, "amendment");
		expect(amendments).toHaveLength(1);
		expect(amendments[0]?.data).toMatchObject({ action: "edit", unit: "U3", old: unitDigest(u3), new: newDigest, outcome: "approved" });
		expect((amendments[0]?.data as { superseded?: boolean }).superseded).toBeUndefined();
		expect(ofKind(marked, "decision")).toHaveLength(2);
		expect(deriveLocks(parseChange(await f.world.bodyOf(f.n)), marked).frozen).toEqual([]);
	});

	test("Unit finished while the drop was pending", async () => {
		const f = await fixture("build");
		await seedLock(f);
		const u3 = parseChange(await f.world.bodyOf(f.n)).units[1]!;
		const record = await prepare(f, "gate", "amend:1", { action: "drop", unit: "U3", oldDigest: unitDigest(u3), oldDone: false, records: [] });
		const approver = createForgeApprover(f.world.forge, f.n);
		await approver.request(envelope(record));
		await f.world.editBodyBehindBack(f.n, u3Done(await f.world.bodyOf(f.n)));
		await f.world.setPermission("alice", "write");
		await f.world.postComment(f.n, "alice", "/livespec approve");
		const polled = await approver.poll(record.id);
		if (polled.status !== "answered") throw new Error("not answered");
		const out = await completeAnswer(await ctxOf(f), record, polled);
		expect(out.status).toBe("superseded");
		const body = await f.world.bodyOf(f.n);
		expect(parseChange(body).units.map((u) => u.id)).toEqual(["U1", "U3"]);
		const marked = await markedOf(f);
		expect((ofKind(marked, "amendment")[0]?.data as { superseded?: boolean }).superseded).toBe(true);
		expect(Object.keys(deriveLocks(parseChange(body), marked).locked ?? {})).toEqual(["U1", "U3"]);
	});

	test("Unit id taken while the add was pending", async () => {
		const f = await fixture("build");
		await seedLock(f);
		const before = await f.world.bodyOf(f.n);
		const lines = renderUnit({ id: "U4", title: "Burst", covers: [REQUIREMENT], difficulty: "low", tags: [], files: ["src/b.ts"], done_means: [{ label: "b", text: "burst" }], scenarios: [{ label: "b", ref: "test/ratelimit.test.ts › rejects 101st request" }], depends: [], verify: "npm test" });
		const record = await prepare(f, "gate", "amend:1", { action: "add", unit: "U4", lines, records: [] });
		const other = renderUnit({ id: "U4", title: "Other", covers: [REQUIREMENT], difficulty: "low", tags: [], files: ["src/o.ts"], done_means: [{ label: "o", text: "other" }], scenarios: [{ label: "o", ref: "test/ratelimit.test.ts › rejects 101st request" }], depends: [], verify: "npm test" });
		await f.world.editBodyBehindBack(f.n, amendedBody(before, { action: "add", unit: "U4", lines: other, records: [] }));
		const out = await completeAnswer(await ctxOf(f), record, answer());
		expect(out.result).toContain("U4 is already in the body");
		const units = parseChange(await f.world.bodyOf(f.n)).units;
		expect(units.find((u) => u.id === "U4")?.title).toBe("Other");
	});

	test("Answer sends the change back", async () => {
		const f = await fixture("build", (b) => u3Done(q1Open(b)));
		await seedLock(f);
		const record = await prepare(f, "question", "question:Q1", { id: "Q1", text: "header?", requirements: [REQUIREMENT] });
		await completeAnswer(await ctxOf(f), record, answer({ answer: "X-Forwarded-For", changesRequirement: REQUIREMENT }));
		const { state } = await stateOf(f);
		expect(state.issue.labels).toContain("livespec:phase/define");
		const [u1, u3] = state.change.units;
		expect(u3?.done).toBe(false);
		expect(state.lock.staleUnits).toEqual(["U3"]);
		expect(u1?.done).toBe(true);
		expect(state.counters.change_iterations).toBe(1);
	});

	test("Retried cascade counts once", async () => {
		const f = await fixture("build", (b) => u3Done(q1Open(b)));
		await seedLock(f);
		const record = await prepare(f, "question", "question:Q1", { id: "Q1", text: "header?", requirements: [REQUIREMENT] });
		const failing = failingOnce(f.world.forge, (op) => op === "addLabels");
		await expect(completeAnswer(await ctxOf(f, failing), record, answer({ answer: "X-Forwarded-For", changesRequirement: REQUIREMENT }))).rejects.toThrow("injected");
		expect(ofKind(await markedOf(f), "stale", "Q1")).toHaveLength(1);
		await finishApplying(await ctxOf(f));
		const { state } = await stateOf(f);
		expect(state.issue.labels).toContain("livespec:phase/define");
		expect(ofKind(state.marked, "stale", "Q1")).toHaveLength(1);
		expect(state.counters.change_iterations).toBe(1);
	});

	test("Override recorded", async () => {
		const f = await fixture("plan");
		await seedClassification(f);
		const record = await prepare(f, "gate", "gate:plan", gateSnapshot("plan"));
		await completeAnswer(await ctxOf(f), record, answer({ overrides: [{ unit: "U3", difficulty: "high" }] }));
		expect(parseChange(await f.world.bodyOf(f.n)).units[1]?.difficulty).toBe("high");
		const latest = latestDecisions(await markedOf(f)).get("difficulty.U3");
		expect(latest).toMatchObject({ source: "human", outcome: "high", overridden_by: { by: "alice", from: "medium" } });
	});

	test("override keeps other lines byte-identical", async () => {
		const f = await fixture("plan", undefined, { crlf: true });
		await seedClassification(f);
		const before = splitLines(await f.world.bodyOf(f.n));
		const record = await prepare(f, "gate", "gate:plan", gateSnapshot("plan"));
		await completeAnswer(await ctxOf(f), record, answer({ overrides: [{ unit: "U3", difficulty: "high" }] }));
		const after = splitLines(await f.world.bodyOf(f.n));
		expect(after).toHaveLength(before.length);
		const changed = after.flatMap((l, i) => (l.text === before[i]?.text && l.eol === before[i]?.eol ? [] : [i]));
		expect(changed).toHaveLength(1);
		expect(after[changed[0]!]).toEqual({ text: "Difficulty: high", eol: "\r\n" });
	});

	test("Choice recorded", async () => {
		const f = await fixture("build");
		const options = [{ id: "A", label: "retry" }, { id: "B", label: "re-plan" }];
		await f.world.postComment(f.n, BOT_LOGIN, writeMarked("stuck", "S1", { where: "U3", tried: [], hypothesis: "h", options, recommended: "A" }));
		expect((await stateOf(f)).step.next).toContain("stuck report S1");
		const record = await prepare(f, "stuck", "stuck:S1", { id: "S1" }, options);
		const polled = await forgeAnswer(f, record, "/livespec choose B");
		await completeAnswer(await ctxOf(f), record, polled);
		const answerComment = ofKind(await markedOf(f), "stuck", "S1-answer")[0];
		expect(answerComment?.data).toMatchObject({ choice: "B", request: record.id });
		const { state, step } = await stateOf(f);
		expect(state.iterations.stuckOpen).toBeUndefined();
		expect(step.next).not.toContain("stuck report");
	});

	test("stuck answer records its outcome", async () => {
		const f = await fixture("build");
		const options = [{ id: "A", label: "retry" }, { id: "B", label: "re-plan" }];
		await f.world.postComment(f.n, BOT_LOGIN, writeMarked("stuck", "S1", { where: "U3", tried: [], hypothesis: "h", options, recommended: "A" }));
		const record = await prepare(f, "stuck", "stuck:S1", { id: "S1" }, options);
		await completeAnswer(await ctxOf(f), record, answer({ outcome: "dismissed", notes: "not now" }));
		expect(ofKind(await markedOf(f), "stuck", "S1-answer")[0]?.data).toMatchObject({ outcome: "dismissed", choice: "" });
	});

	test("gate with overrides resumes after a crash before the override record", async () => {
		const f = await fixture("plan");
		await seedClassification(f);
		const record = await prepare(f, "gate", "gate:plan", gateSnapshot("plan"));
		const crashing = failingOnce(f.world.forge, commentOfKind("decision"));
		await expect(completeAnswer(await ctxOf(f, crashing), record, answer({ overrides: [{ unit: "U3", difficulty: "high" }] }))).rejects.toThrow("injected");
		expect(parseChange(await f.world.bodyOf(f.n)).units[1]?.difficulty).toBe("high");

		expect((await finishApplying(await ctxOf(f))).errors).toEqual([]);
		const marked = await markedOf(f);
		const overrides = ofKind(marked, "decision", "difficulty.U3").filter((m) => (m.data as { source?: string }).source === "human");
		expect(overrides).toHaveLength(1);
		expect(overrides[0]?.data).toMatchObject({ outcome: "high", overridden_by: { by: "alice", from: "medium" } });
		expect(ofKind(marked, "gate").filter((m) => (m.data as { request?: string }).request === record.id)).toHaveLength(1);
		expect(readRequests(marked).applying).toEqual([]);
		expect(await finishApplying(await ctxOf(f))).toEqual({ finished: [], errors: [] });
	});

	test("changes requested resumes after a crash before the gate result", async () => {
		const f = await fixture("define");
		const record = await prepare(f, "gate", "gate:define", gateSnapshot("define"));
		const crashing = failingOnce(f.world.forge, commentOfKind("gate"));
		await expect(completeAnswer(await ctxOf(f, crashing), record, answer({ outcome: "changes_requested", notes: "tighten" }))).rejects.toThrow("injected");
		expect(ofKind(await markedOf(f), "stale", record.id)).toHaveLength(1);

		expect((await finishApplying(await ctxOf(f))).errors).toEqual([]);
		const marked = await markedOf(f);
		expect(ofKind(marked, "stale", record.id)).toHaveLength(1);
		expect(ofKind(marked, "gate")).toHaveLength(1);
		expect(ofKind(marked, "gate")[0]?.data).toMatchObject({ outcome: "changes_requested", request: record.id });
		expect(readRequests(marked).applying).toEqual([]);
		expect(await finishApplying(await ctxOf(f))).toEqual({ finished: [], errors: [] });
	});

	test("completion result wraps forge text as untrusted", async () => {
		const f = await fixture("build");
		const options = [{ id: "A", label: "retry" }, { id: "B", label: "re-plan" }];
		await f.world.postComment(f.n, BOT_LOGIN, writeMarked("stuck", "S1", { where: "U3", tried: [], hypothesis: "h", options, recommended: "A" }));
		const record = await prepare(f, "stuck", "stuck:S1", { id: "S1" }, options);
		const out = await completeAnswer(await ctxOf(f), record, answer({ choice: "B", by: "ev<il" }));
		expect(out.result).toContain(untrusted("ev<il"));
		expect(out.result).not.toContain("ev<il");
	});

	const STEPS: [name: string, failsOn: (op: string, args: unknown[]) => boolean][] = [
		["body write", (op) => op === "updateIssueBody"],
		["stale comment", commentOfKind("stale")],
		["add label", (op) => op === "addLabels"],
		["remove label", (op) => op === "removeLabels"],
		["result comment", commentOfKind("question")],
	];

	test.each(STEPS)("completion resumes after each failing step (%s)", async (_name, failsOn) => {
		const f = await fixture("build", (b) => u3Done(q1Open(b)));
		await seedLock(f);
		const record = await prepare(f, "question", "question:Q1", { id: "Q1", text: "header?", requirements: [REQUIREMENT] });
		const failing = failingOnce(f.world.forge, failsOn);
		await expect(completeAnswer(await ctxOf(f, failing), record, answer({ answer: "X-Forwarded-For", changesRequirement: REQUIREMENT }))).rejects.toThrow("injected");
		const finished = await finishApplying(await ctxOf(f));
		expect(finished.errors).toEqual([]);
		const { state } = await stateOf(f);
		expect(ofKind(state.marked, "stale")).toHaveLength(1);
		expect(ofKind(state.marked, "question")).toHaveLength(1);
		expect(state.counters.change_iterations).toBe(1);
		expect(state.issue.labels.filter((l) => l.startsWith("livespec:phase/"))).toEqual(["livespec:phase/define"]);
		expect(readRequests(state.marked).applying).toEqual([]);
		expect(await finishApplying(await ctxOf(f))).toEqual({ finished: [], errors: [] });
	});
});
