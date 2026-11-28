import { execFileSync } from "node:child_process";
import { readOwnRecords } from "../../src/ledger/records.ts";
import { appendEntry } from "../../src/ledger/store.ts";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import "../../src/deps/markers.ts";
import "../../src/engine/comments-cache.ts";
import { registerGate, registerGateEffect, registerGateValidator, resetGatesForTests } from "../../src/engine/gates.ts";
import { hasMarked, postComment, type Run } from "../../src/interaction/complete-effects.ts";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { splitLines } from "../../src/core/lines.ts";
import { renderUnit } from "../../src/core/unit-blocks.ts";
import { currentDecision, decisionComment, latestDecisions } from "../../src/decide/records.ts";
import { advancePhase } from "../../src/engine/advance.ts";
import { registerBuiltinChecks, runChecks } from "../../src/engine/checks.ts";
import type { CommentsCache } from "../../src/engine/comments-cache.ts";
import { defaultGitExec } from "../../src/engine/git-exec.ts";
import { createGit } from "../../src/engine/git.ts";
import { createLedger, type Ledger } from "../../src/ledger/index.ts";
import { deriveLocks, validApproval } from "../../src/engine/locks.ts";
import { registerCheck } from "../../src/engine/registry.ts";
import { nextStep } from "../../src/engine/next-step.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { readChangeSnapshot } from "../../src/engine/snapshot.ts";
import type { ChangeState } from "../../src/engine/state-types.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import { amendedBody } from "../../src/interaction/amend-body.ts";
import type { AmendSnapshot, Answered, ApprovalRequest, RequestKind, RequestRecord, RequestSnapshot, Subject } from "../../src/interaction/approver.ts";
import { type CompletionCtx, completeAnswer, finishApplying } from "../../src/interaction/complete.ts";
import { createForgeApprover } from "../../src/interaction/forge.ts";
import { renderForgeRequest } from "../../src/interaction/forge-text.ts";
import { answerComment, prepareRequest, readRequests, requestComment } from "../../src/interaction/requests.ts";
import { untrusted } from "../../src/hooks/phase-card.ts";
import { matchedAnswer } from "../helpers/matched-answer.ts";
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
	return (await readOwnRecords(f.world.forge, createLedger(defaultGitExec, f.root), f.n, { login: BOT_LOGIN })).records;
}

async function ctxOf(f: Fixture, forge: Forge = f.world.forge, ledger: Ledger = createLedger(defaultGitExec, f.root)): Promise<CompletionCtx> {
	return { forge, ledger, git: f.git, pack: f.pack, issue: f.n, marked: await markedOf(f), root: f.root, agentSkills: AGENT_SKILLS, now: () => new Date(AT) };
}

const comments = { list: async (forge: Forge, issue: { number: number }) => ({ comments: await forge.listComments(issue.number), stale: false }) } as unknown as CommentsCache;

/** The change state and next step as `Session.refresh` sees them. */
async function stateOf(f: Fixture): Promise<{ state: ChangeState; step: ReturnType<typeof nextStep> }> {
	const snapshot = await readChangeSnapshot({ forge: f.world.forge, ledger: createLedger(defaultGitExec, f.root), fetch: false, isReadOnly: () => false, git: f.git, comments, caps: { iterations: f.pack.loops.change_iterations, unitAttempts: f.pack.loops.unit_attempts } }, f.n);
	const state = { ...snapshot, checks: await runChecks(f.pack, snapshot, { root: f.root, git: f.git }) };
	return { state, step: nextStep(f.pack, state) };
}

/** `Session.refresh`: apply the derived advance once. */
async function refresh(f: Fixture): Promise<ChangeState> {
	const { step } = await stateOf(f);
	if (step.advance) await advancePhase(f.world.forge, f.n, step.advance, f.pack);
	return (await stateOf(f)).state;
}

async function prepare(f: Fixture, kind: RequestKind, subject: Subject, snapshot: RequestSnapshot, options?: { id: string; label: string }[]): Promise<RequestRecord> {
	const body = await f.world.bodyOf(f.n);
	return prepareRequest({ kind, subject, mode: "blocking", ...(options ? { options } : {}), head: f.head, body, snapshot, summary: `Review ${subject}`, now: new Date(AT) });
}

function envelope(record: RequestRecord): ApprovalRequest {
	return { id: record.id, kind: record.kind, subject: record.subject, record, change: 1, phase: "x", summary: record.summary, links: [], files: [], mode: record.mode, ...(record.options ? { options: record.options } : {}) };
}

const answer = (over: Partial<Answered> = {}): Answered => ({ status: "answered", outcome: "approved", notes: "", by: "alice", at: AT, adapter: "in-session", ...over });

const gateSnapshot = (target: string) => ({ target, failingWaivable: [] });

/** Posts the forge request, then a writer's command, and returns the polled answer. */
async function forgeAnswer(f: Fixture, record: RequestRecord, command: string): Promise<Answered> {
	const approver = createForgeApprover(f.world.forge, createLedger(defaultGitExec, f.root), f.n);
	await approver.request(envelope(record));
	await f.world.setPermission("alice", "write");
	await f.world.postComment(f.n, "alice", command);
	const polled = await matchedAnswer(f.world.forge, f.n, record.id);
	if (!polled) throw new Error("not answered");
	return polled;
}

function ofKind(marked: MarkedComment[], kind: string, id?: string): MarkedComment[] {
	return marked.filter((m) => m.kind === kind && (id === undefined || m.id === id));
}

async function seedClassification(f: Fixture): Promise<void> {
	for (const u of parseChange(await f.world.bodyOf(f.n)).units) {
		const digest = unitDigest(u);
		await appendEntry(defaultGitExec, f.root, f.n, decisionComment({ point: "tags", subject: u.id, digest, source: "rule", outcome: u.tags, reason: "rule" }));
		await appendEntry(defaultGitExec, f.root, f.n, decisionComment({ point: "difficulty", subject: u.id, digest, source: "rule", outcome: u.difficulty, reason: "rule" }));
	}
}

/** An approved plan gate locking the current units. */
async function seedLock(f: Fixture): Promise<void> {
	const locked = Object.fromEntries(parseChange(await f.world.bodyOf(f.n)).units.map((u) => [u.id, unitDigest(u)]));
	const data = { phase: "plan", outcome: "approved", notes: "", by: "alice", at: AT, adapter: "in-session", head_sha: f.head, waivers: [], locked };
	await f.world.postComment(f.n, BOT_LOGIN, writeMarked("gate", "plan.self-1", data));
}

/** A forge wrapper that throws once on the first call `failsOn` matches. */
function failingOnce<T extends object>(inner: T, failsOn: (op: string, args: unknown[]) => boolean): T {
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

	test("Plan gate records the digests: the approved gate comment copies the snapshot record without reading git", async () => {
		const f = await fixture("plan");
		await seedClassification(f);
		const requirements = { [REQUIREMENT]: "d".repeat(64) };
		const record = await prepare(f, "gate", "gate:plan", { ...gateSnapshot("plan"), requirements, requirement_scope: ["rate-limit"] });
		const showFile = vi.fn(async () => {
			throw new Error("completion must not read git for the baseline");
		});
		const ctx = { ...(await ctxOf(f)), git: { ...f.git, showFile } };
		const out = await completeAnswer(ctx, record, answer());
		expect(out.status).toBe("completed");
		const gate = ofKind(await markedOf(f), "gate").at(-1)?.data as Record<string, unknown>;
		expect(gate.requirements).toEqual(requirements);
		expect(gate.requirement_scope).toEqual(["rate-limit"]);
		expect(showFile).not.toHaveBeenCalled();
	});

	test("an approved plan request stored without a requirement record writes neither field", async () => {
		const f = await fixture("plan");
		await seedClassification(f);
		const record = await prepare(f, "gate", "gate:plan", gateSnapshot("plan"));
		await completeAnswer(await ctxOf(f), record, answer());
		const gate = ofKind(await markedOf(f), "gate").at(-1)?.data as Record<string, unknown>;
		expect(gate).not.toHaveProperty("requirements");
		expect(gate).not.toHaveProperty("requirement_scope");
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

	test("a ship answer is validated with the ship context: a refused context supersedes it", async () => {
		const f = await fixture("ship");
		const record = await prepare(f, "gate", "gate:ship", gateSnapshot("ship"));
		const polled = await forgeAnswer(f, record, "/livespec approve");
		const out = await completeAnswer({ ...(await ctxOf(f)), shipFor: async () => ({ refused: "no integration branch" }) }, record, polled);
		expect(out.status).toBe("superseded");
	});

	test("Issue edited before the answer", async () => {
		const f = await fixture("define");
		const record = await prepare(f, "gate", "gate:define", gateSnapshot("define"));
		const approver = createForgeApprover(f.world.forge, createLedger(defaultGitExec, f.root), f.n);
		await approver.request(envelope(record));
		await f.world.editBodyBehindBack(f.n, (await f.world.bodyOf(f.n)).replace("Limit each client IP.", "Limit each client IP and user."));
		await f.world.setPermission("alice", "write");
		await f.world.postComment(f.n, "alice", "/livespec approve");
		const polled = await matchedAnswer(f.world.forge, f.n, record.id);
		if (!polled) throw new Error("not answered");
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

	test("an approval that does not waive failing waivable checks is superseded", async () => {
		const f = await fixture("define");
		const options = [{ id: "waive", label: "Waive size-limits" }, { id: "accept", label: "accept" }];
		const record = await prepare(f, "gate", "gate:define", { target: "define", failingWaivable: ["size-limits"] }, options);
		const out = await completeAnswer(await ctxOf(f), record, answer({ choice: "accept" }));
		expect(out.status).toBe("superseded");
		expect(out.result).toContain("choose waive");
		const gate = ofKind(await markedOf(f), "gate").at(-1)?.data as { superseded?: boolean; waivers: string[] };
		expect(gate.superseded).toBe(true);
		expect(gate.waivers).toEqual([]);
		expect((await refresh(f)).issue.labels).toContain("livespec:phase/define");
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

	test("gate comment records the findings of the request snapshot, in-session and forge", async () => {
		const f = await fixture("define");
		const snapshot = { target: "define", failingWaivable: [], findings: ["c9:0", "c9:2"] };
		const inSession = await prepare(f, "gate", "gate:define", snapshot);
		await completeAnswer(await ctxOf(f), inSession, answer());
		expect((ofKind(await markedOf(f), "gate").at(-1)?.data as { findings?: string[] }).findings).toEqual(["c9:0", "c9:2"]);
		const g = await fixture("define");
		const record = await prepare(g, "gate", "gate:define", snapshot);
		const polled = await forgeAnswer(g, record, "/livespec approve");
		await completeAnswer(await ctxOf(g), record, polled);
		const data = ofKind(await markedOf(g), "gate").at(-1)?.data as { adapter: string; findings?: string[] };
		expect(data.adapter).toBe("forge");
		expect(data.findings).toEqual(["c9:0", "c9:2"]);
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

	test("amendment retry keeps its override current", async () => {
		const f = await fixture("build");
		await seedLock(f);
		const before = await f.world.bodyOf(f.n);
		const u3 = parseChange(before).units[1]!;
		const lines = renderUnit({ id: "U3", title: u3.title, covers: u3.covers, difficulty: "medium", tags: ["security", "api"], files: u3.files, done_means: u3.doneMeans, scenarios: u3.scenarios, depends: ["U1"], verify: "npm test -- ratelimit-v2" });
		const snapshot: AmendSnapshot = { action: "edit", unit: "U3", oldDigest: unitDigest(u3), oldDone: false, lines, records: [] };
		const newDigest = unitDigest(parseChange(amendedBody(before, snapshot)).units[1]!);
		snapshot.records = [{ point: "difficulty", subject: "U3", digest: newDigest, source: "rule", outcome: "medium", reason: "rule" }];
		const record = await prepare(f, "gate", "amend:1", snapshot);
		const crashing = failingOnce(f.world.forge, commentOfKind("amendment"));
		await expect(completeAnswer(await ctxOf(f, crashing), record, answer({ overrides: [{ unit: "U3", difficulty: "high" }] }))).rejects.toThrow("injected");

		expect((await finishApplying(await ctxOf(f))).errors).toEqual([]);
		const marked = await markedOf(f);
		expect(ofKind(marked, "decision", "difficulty.U3").map((m) => (m.data as { source: string }).source)).toEqual(["rule", "human"]);
		expect(currentDecision(marked, "difficulty", "U3", newDigest)).toMatchObject({ source: "human", outcome: "high" });
	});

	test("Unit finished while the drop was pending", async () => {
		const f = await fixture("build");
		await seedLock(f);
		const u3 = parseChange(await f.world.bodyOf(f.n)).units[1]!;
		const record = await prepare(f, "gate", "amend:1", { action: "drop", unit: "U3", oldDigest: unitDigest(u3), oldDone: false, records: [] });
		const approver = createForgeApprover(f.world.forge, createLedger(defaultGitExec, f.root), f.n);
		await approver.request(envelope(record));
		await f.world.editBodyBehindBack(f.n, u3Done(await f.world.bodyOf(f.n)));
		await f.world.setPermission("alice", "write");
		await f.world.postComment(f.n, "alice", "/livespec approve");
		const polled = await matchedAnswer(f.world.forge, f.n, record.id);
		if (!polled) throw new Error("not answered");
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
		expect(out.result).toContain(`${untrusted("U4")} is already in the body`);
		const units = parseChange(await f.world.bodyOf(f.n)).units;
		expect(units.find((u) => u.id === "U4")?.title).toBe("Other");
	});

	test("Answer writes only the answer line and leaves the change where it is", async () => {
		const f = await fixture("build", (b) => u3Done(q1Open(b)));
		await seedLock(f);
		const record = await prepare(f, "question", "question:Q1", { id: "Q1", text: "header?" });
		await completeAnswer(await ctxOf(f), record, answer({ answer: "X-Forwarded-For" }));
		const { state } = await stateOf(f);
		expect(state.issue.labels).toContain("livespec:phase/build");
		expect(state.change.units.find((u) => u.id === "U3")?.done).toBe(true);
		expect(ofKind(state.marked, "stale")).toHaveLength(0);
		expect(state.counters.change_iterations).toBe(0);
		expect(state.change.questions.find((q) => q.id === "Q1")?.checked).toBe(true);
	});

	test("A stored snapshot that still carries requirements completes", async () => {
		const f = await fixture("define", q1Open);
		const legacy = { id: "Q1", text: "header?", requirements: [REQUIREMENT] } as unknown as RequestSnapshot;
		const record = await prepare(f, "question", "question:Q1", legacy);
		await completeAnswer(await ctxOf(f), record, answer({ answer: "X-Forwarded-For" }));
		expect(ofKind((await stateOf(f)).state.marked, "question")).toHaveLength(1);
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
		expect((await stateOf(f)).step.next).toBe("Stuck report S1 has no pending request: send it again with spec_stuck.");
		const record = await prepare(f, "stuck", "stuck:S1", { id: "S1" }, options);
		const polled = await forgeAnswer(f, record, "/livespec choose B");
		await completeAnswer(await ctxOf(f), record, polled);
		const answerComment = ofKind(await markedOf(f), "stuck", "S1-answer")[0];
		expect(answerComment?.data).toMatchObject({ choice: "B", request: record.id, outcome: "approved" });
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
		const crashing = failingOnce(createLedger(defaultGitExec, f.root), (op) => op === "append");
		await expect(completeAnswer(await ctxOf(f, f.world.forge, crashing), record, answer({ overrides: [{ unit: "U3", difficulty: "high" }] }))).rejects.toThrow("injected");
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

	test("Decision result in the ledger", async () => {
		const f = await fixture("build");
		const options = [{ id: "x", label: "X" }, { id: "y", label: "Y" }];
		const record = await prepare(f, "stuck", "decide:pick.U1", { point: "pick", subject: "U1", facts: {}, digest: "d1" }, options);
		await completeAnswer(await ctxOf(f), record, answer({ choice: "y" }));
		const forgeKinds = filterMarked(await f.world.forge.listComments(f.n), BOT_LOGIN).comments.map((m) => m.kind);
		expect(forgeKinds).not.toContain("decision");
		const marked = await markedOf(f);
		const [decision] = ofKind(marked, "decision", "pick.U1");
		expect(decision).toMatchObject({ source: "ledger", data: { source: "human", outcome: "y", request: record.id } });
		expect(readRequests(marked)).toEqual({ pending: [], applying: [] });
		// Completed by the entry alone: finishing again appends nothing.
		expect(await finishApplying(await ctxOf(f))).toEqual({ finished: [], errors: [] });
		expect(ofKind(await markedOf(f), "decision", "pick.U1")).toHaveLength(1);
	});

	test("decide resumes after a crash before the decision entry", async () => {
		const f = await fixture("build");
		const options = [{ id: "x", label: "X" }, { id: "y", label: "Y" }];
		const record = await prepare(f, "stuck", "decide:pick.U1", { point: "pick", subject: "U1", facts: {}, digest: "d1" }, options);
		const crashing = failingOnce(createLedger(defaultGitExec, f.root), (op) => op === "append");
		await expect(completeAnswer(await ctxOf(f, f.world.forge, crashing), record, answer({ choice: "y" }))).rejects.toThrow("injected");
		expect(ofKind(await markedOf(f), "decision", "pick.U1")).toEqual([]);

		expect((await finishApplying(await ctxOf(f))).errors).toEqual([]);
		const marked = await markedOf(f);
		expect(ofKind(marked, "decision", "pick.U1")).toHaveLength(1);
		expect(readRequests(marked)).toEqual({ pending: [], applying: [] });
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

	test("superseded reason is wrapped once", async () => {
		const f = await fixture("define");
		const record = await prepare(f, "gate", "gate:define", gateSnapshot("define"));
		registerCheck("spec-format", async () => [{ code: "x", severity: "error", message: "bad <b>title</b>" }]);
		try {
			const out = await completeAnswer(await ctxOf(f), record, answer());
			expect(out.status).toBe("superseded");
			expect(out.result.match(/<untrusted>/g)).toHaveLength(2); // the subject and the failing check message
			expect(out.result).toContain(untrusted("bad <b>title</b>"));
			expect(out.result).not.toContain("&lt;untrusted&gt;");
		} finally {
			registerBuiltinChecks();
		}
	});

	test("a legacy superseded reason is wrapped whole when its applying answer finishes", async () => {
		const f = await fixture("build");
		await seedLock(f);
		const record = await prepare(f, "gate", "amend:1", { action: "drop", unit: "U3", records: [] });
		const legacy = { request: record, answer: answer(), verdict: "superseded" as const, reason: 'U3: Difficulty "<b>forge</b>" must be low' };
		await f.world.postComment(f.n, BOT_LOGIN, answerComment(record.id, legacy));
		const out = await finishApplying(await ctxOf(f));
		expect(out.errors).toEqual([]);
		expect(out.finished[0]?.result).toContain(untrusted(legacy.reason));
		expect(out.finished[0]?.result).not.toContain("<b>");
	});

	test("malformed own stale-unit text stays escaped in a superseded reason", async () => {
		const f = await fixture("plan");
		await seedLock(f);
		await f.world.postComment(f.n, BOT_LOGIN, writeMarked("stale", "s1", { phases: [], units: ["<b>forge-stale-text</b>"] }));
		const record = await prepare(f, "gate", "gate:plan", gateSnapshot("plan"));
		const out = await completeAnswer(await ctxOf(f), record, answer());
		expect(out.status).toBe("superseded");
		expect(out.result).toContain("forge-stale-text");
		expect(out.result.replace(/<untrusted>[\s\S]*?<\/untrusted>/g, "")).not.toContain("<b>");
	});

	test("legacy wrapped reason stays escaped", async () => {
		const f = await fixture("define");
		const record = await prepare(f, "gate", "gate:define", gateSnapshot("define"));
		const legacy = { request: record, answer: answer(), verdict: "superseded" as const, reason: `Check x fails: ${untrusted("<b>forge</b>")}.` };
		await f.world.postComment(f.n, BOT_LOGIN, answerComment(record.id, legacy));
		const out = await finishApplying(await ctxOf(f));
		const text = out.finished[0]?.result ?? "";
		expect(text).toContain("forge");
		expect(text.replace(/<untrusted>[\s\S]*?<\/untrusted>/g, "")).not.toContain("<b>");
	});

	test("a newly recorded superseded answer marks its reason as already wrapped", async () => {
		const f = await fixture("define");
		const record = await prepare(f, "gate", "gate:define", { target: "define", failingWaivable: ["size-limits"] });
		await completeAnswer(await ctxOf(f), record, answer());
		const [recorded] = ofKind(await markedOf(f), "answer", record.id);
		expect(recorded?.data).toMatchObject({ verdict: "superseded", reason_wrapped: true });
	});

	test("answer comment keeps the briefing", async () => {
		const f = await fixture("define");
		const briefing = { summary: "The spec is small.", recommended: "approve", rationale: "Checks pass.", author: "agent" as const };
		const record = { ...(await prepare(f, "gate", "gate:define", gateSnapshot("define"))), briefing };
		const polled = await forgeAnswer(f, record, "/livespec approve");
		await completeAnswer(await ctxOf(f), record, polled);
		const [recorded] = ofKind(await markedOf(f), "answer", record.id);
		expect((recorded?.data as { request: RequestRecord }).request.briefing).toEqual(briefing);
	});

	test("a request stored without a briefing reads, renders and completes", async () => {
		const f = await fixture("define");
		const record = await prepare(f, "gate", "gate:define", gateSnapshot("define"));
		expect(record.briefing).toBeUndefined();
		// A request stored before this change: yaml without `briefing`, old plain text.
		await f.world.postComment(f.n, BOT_LOGIN, requestComment(record.id, record, "**livespec asks for gate:define** (blocking):"));
		const [stored] = readRequests(await markedOf(f)).pending;
		expect(stored?.data.briefing).toBeUndefined();
		const rendered = renderForgeRequest(envelope(record));
		expect(rendered).not.toContain("recommendation");
		expect(rendered).not.toContain("(recommended)");
		await f.world.setPermission("alice", "write");
		await f.world.postComment(f.n, "alice", "/livespec approve");
		const polled = await matchedAnswer(f.world.forge, f.n, record.id);
		if (!polled) throw new Error("not answered");
		const out = await completeAnswer(await ctxOf(f), record, polled);
		expect(out.status).toBe("completed");
		expect(ofKind(await markedOf(f), "gate").at(-1)?.data).toMatchObject({ phase: "define", outcome: "approved", adapter: "forge" });
	});

	test("applying answers of every subject kind still complete", async () => {
		const f = await fixture("build");
		const cases: [RequestKind, Subject, RequestSnapshot][] = [
			["gate", "gate:define", gateSnapshot("define")],
			["gate", "amend:1", { action: "drop", unit: "U9", records: [] }],
			["question", "question:Q1", { id: "Q1", text: "header?" }],
			["stuck", "stuck:S1", { id: "S1" }],
			["stuck", "decide:difficulty.U1", { point: "difficulty", subject: "U1", facts: {}, digest: "d", proposal: true }],
		];
		for (const [kind, subject, snapshot] of cases) {
			const record = await prepare(f, kind, subject, snapshot);
			await f.world.postComment(f.n, BOT_LOGIN, answerComment(record.id, { request: record, answer: answer({ choice: "A" }), verdict: "valid" }));
		}
		const out = await finishApplying(await ctxOf(f));
		expect(out.errors).toEqual([]);
		expect(out.finished).toHaveLength(cases.length);
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

	test("completion result carries the human's notes, wrapped as untrusted (in-session)", async () => {
		const f = await fixture("define");
		const record = await prepare(f, "gate", "gate:define", gateSnapshot("define"));
		const out = await completeAnswer(await ctxOf(f), record, answer({ outcome: "changes_requested", notes: "tighten <the> cap" }));
		expect(out.result).toContain(`Notes: ${untrusted("tighten <the> cap")}`);
		expect(out.result).not.toContain("tighten <the> cap");
	});

	test("completion result carries the human's notes, wrapped as untrusted (forge)", async () => {
		const f = await fixture("define");
		const record = await prepare(f, "gate", "gate:define", gateSnapshot("define"));
		const polled = await forgeAnswer(f, record, "/livespec changes cover IPv6 too");
		const out = await completeAnswer(await ctxOf(f), record, polled);
		expect(out.result).toContain(`Notes: ${untrusted("cover IPv6 too")}`);
	});

	test("completion result of a stuck answer carries its notes", async () => {
		const f = await fixture("build");
		const options = [{ id: "A", label: "retry" }, { id: "B", label: "re-plan" }];
		await f.world.postComment(f.n, BOT_LOGIN, writeMarked("stuck", "S1", { where: "U3", tried: [], hypothesis: "h", options, recommended: "A" }));
		const record = await prepare(f, "stuck", "stuck:S1", { id: "S1" }, options);
		const polled = await forgeAnswer(f, record, "/livespec choose B split U3 first");
		const out = await completeAnswer(await ctxOf(f), record, polled);
		expect(out.result).toContain(`Notes: ${untrusted("split U3 first")}`);
	});

	test("completion result of a question carries the answer", async () => {
		const f = await fixture("build", (b) => u3Done(q1Open(b)));
		await seedLock(f);
		const record = await prepare(f, "question", "question:Q1", { id: "Q1", text: "header?" });
		const out = await completeAnswer(await ctxOf(f), record, answer({ answer: "X-Forwarded-For" }));
		expect(out.result).toContain(`Answer: ${untrusted("X-Forwarded-For")}`);
		expect(out.result).not.toContain("Changes requirement");
	});

	test("completion result of a forge question answer carries the answer", async () => {
		const f = await fixture("define", q1Open);
		const record = await prepare(f, "question", "question:Q1", { id: "Q1", text: "header?" });
		const polled = await forgeAnswer(f, record, "/livespec answer Q1 use X-Real-IP");
		const out = await completeAnswer(await ctxOf(f), record, polled);
		expect(out.result).toContain(`Answer: ${untrusted("use X-Real-IP")}`);
	});

	const STEPS: [name: string, failsOn: (op: string, args: unknown[]) => boolean][] = [
		["body write", (op) => op === "updateIssueBody"],
		["result comment", commentOfKind("question")],
	];

	test.each(STEPS)("completion resumes after each failing step (%s)", async (_name, failsOn) => {
		const f = await fixture("build", (b) => u3Done(q1Open(b)));
		await seedLock(f);
		const record = await prepare(f, "question", "question:Q1", { id: "Q1", text: "header?" });
		const failing = failingOnce(f.world.forge, failsOn);
		await expect(completeAnswer(await ctxOf(f, failing), record, answer({ answer: "X-Forwarded-For" }))).rejects.toThrow("injected");
		const finished = await finishApplying(await ctxOf(f));
		expect(finished.errors).toEqual([]);
		const { state } = await stateOf(f);
		expect(ofKind(state.marked, "stale")).toHaveLength(0);
		expect(ofKind(state.marked, "question")).toHaveLength(1);
		expect(state.issue.labels.filter((l) => l.startsWith("livespec:phase/"))).toEqual(["livespec:phase/build"]);
		expect(readRequests(state.marked).applying).toEqual([]);
		expect(await finishApplying(await ctxOf(f))).toEqual({ finished: [], errors: [] });
	});
});

describe("named gate seam", () => {
	afterEach(() => resetGatesForTests());

	const EFFECT_ID = "effect.new-dependency";
	const effectBody = writeMarked("skill-note", EFFECT_ID, { by: "effect" });
	/** An idempotent effect: it writes its own comment unless that comment exists. */
	const writingEffect = vi.fn(async (run: Run) => {
		if (!hasMarked(run, "skill-note", EFFECT_ID)) await postComment(run, effectBody);
	});

	test("Validator supersedes", async () => {
		const f = await fixture("build");
		const effect = vi.fn(async () => {});
		registerGate("initiative", { checks: [], proposer: "initiative_propose" });
		registerGateValidator("initiative", async () => "name taken");
		registerGateEffect("initiative", effect);
		const record = await prepare(f, "gate", "gate:initiative", gateSnapshot("initiative"));
		const out = await completeAnswer(await ctxOf(f), record, answer());
		expect(out.status).toBe("superseded");
		const recorded = ofKind(await markedOf(f), "answer").at(-1)?.data as { verdict: string; reason: string };
		expect(recorded.verdict).toBe("superseded");
		expect(recorded.reason).toContain("name taken");
		expect(effect).not.toHaveBeenCalled();
	});

	test("approved initiative answer is valid", async () => {
		const f = await fixture("build");
		registerGate("initiative", { checks: [], proposer: "initiative_propose" });
		const record = await prepare(f, "gate", "gate:initiative", gateSnapshot("initiative"));
		const out = await completeAnswer(await ctxOf(f), record, answer());
		expect(out.status).toBe("completed");
		expect((ofKind(await markedOf(f), "answer").at(-1)?.data as { verdict: string }).verdict).toBe("valid");
	});

	test("Gate effect runs once before the result", async () => {
		const f = await fixture("build");
		writingEffect.mockClear();
		registerGate("new-dependency", { checks: [], proposer: "new_dependency" });
		registerGateEffect("new-dependency", writingEffect);
		const record = await prepare(f, "gate", "gate:new-dependency", gateSnapshot("new-dependency"));
		const crashing = failingOnce(f.world.forge, commentOfKind("gate"));
		await expect(completeAnswer(await ctxOf(f, crashing), record, answer())).rejects.toThrow("injected");
		expect(ofKind(await markedOf(f), "skill-note", EFFECT_ID)).toHaveLength(1);
		expect(ofKind(await markedOf(f), "gate")).toEqual([]);

		const finished = await finishApplying(await ctxOf(f));
		expect(finished.errors).toEqual([]);
		const marked = await markedOf(f);
		expect(ofKind(marked, "skill-note", EFFECT_ID)).toHaveLength(1);
		const gates = ofKind(marked, "gate");
		expect(gates).toHaveLength(1);
		const order = marked.map((m) => m.kind);
		expect(order.indexOf("skill-note")).toBeLessThan(order.indexOf("gate"));
		expect(writingEffect).toHaveBeenCalledTimes(2);
	});

	test("No effect on changes requested", async () => {
		const f = await fixture("build");
		const effect = vi.fn(async () => {});
		registerGate("new-dependency", { checks: [], proposer: "new_dependency" });
		registerGateEffect("new-dependency", effect);
		const record = await prepare(f, "gate", "gate:new-dependency", gateSnapshot("new-dependency"));
		const out = await completeAnswer(await ctxOf(f), record, answer({ outcome: "changes_requested" }));
		expect(out.status).toBe("completed");
		expect(effect).not.toHaveBeenCalled();
		expect(ofKind(await markedOf(f), "gate")).toHaveLength(1);
	});

	test("Proposer gate survives work in progress", async () => {
		const f = await fixture("build");
		registerGate("new-dependency", { checks: [], proposer: "new_dependency" });
		await writeIn(f.root, "src/lane.ts", "wip\n");
		const record = await prepare(f, "gate", "gate:new-dependency", gateSnapshot("new-dependency"));
		await f.world.editBodyBehindBack(f.n, u3Done(await f.world.bodyOf(f.n)));
		commitAll(f.root, "unit done");
		await writeIn(f.root, "src/more.ts", "wip\n");
		const out = await completeAnswer(await ctxOf(f), record, answer());
		expect(out.status).toBe("completed");
		expect((ofKind(await markedOf(f), "answer").at(-1)?.data as { verdict: string }).verdict).toBe("valid");
	});

	test("Forge answer on a parked change", async () => {
		const f = await fixture("plan");
		await seedClassification(f);
		const record = await prepare(f, "gate", "gate:plan", gateSnapshot("plan"));
		const polled = await forgeAnswer(f, record, "/livespec approve");
		await f.world.postComment(f.n, BOT_LOGIN, writeMarked("parked", "parked.a", { waits_for: [34], units: [], at: AT }));
		const out = await completeAnswer(await ctxOf(f), record, polled);
		expect(out.status).toBe("superseded");
		expect(out.result).toContain("parked");
		expect((ofKind(await markedOf(f), "gate").at(-1)?.data as { superseded?: boolean }).superseded).toBe(true);
		expect((await refresh(f)).issue.labels).toContain("livespec:phase/plan");
	});
});
