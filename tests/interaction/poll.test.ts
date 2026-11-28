import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGitExec, type GitExec } from "../../src/engine/git-exec.ts";
import type { AppendInput } from "../../src/ledger/entry.ts";
import { createLedger } from "../../src/ledger/index.ts";
import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import { getSession, setSession } from "../../src/hooks/session-store.ts";
import type { RequestRecord, RequestSnapshot, Subject } from "../../src/interaction/approver.ts";
import { pollApprovals } from "../../src/interaction/poll.ts";
import { contractFields } from "../helpers/briefing.ts";
import { answerComment, prepareRequest, requestComment } from "../../src/interaction/requests.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { CHANGE_BRANCH, cardText, cleanupHomes, deferred, harness, resumeBody } from "../hooks/helpers.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, textOf, toolHarness } from "../tools/helpers.ts";
import type { MemoryWorld } from "../forge/memory-forge.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupHomes();
	await cleanupDirs();
});

const SPEC = readFileSync(new URL("../fixtures/rate-limit.spec.md", import.meta.url), "utf8");
const DEFINE_LABELS = ["livespec", "livespec:phase/define"];
const BUILD_LABELS = ["livespec", "livespec:phase/build"];
const REQUIREMENT = "rate-limit/Requirement: Per-IP cap";
const STUCK_OPTIONS = [{ id: "A", label: "retry" }, { id: "B", label: "re-plan" }];

const rev = (root: string, ref = "HEAD") => execFileSync("git", ["rev-parse", ref], { cwd: root, encoding: "utf8" }).trim();

async function postRequest(world: MemoryWorld, n: number, r: RequestRecord): Promise<void> {
	await world.postComment(n, BOT_LOGIN, requestComment(r.id, r, "plain text"));
}

function request(kind: RequestRecord["kind"], subject: Subject, snapshot: RequestSnapshot, body: string, head: string, at: number, options?: RequestRecord["options"]): RequestRecord {
	return prepareRequest({ kind, subject, mode: "blocking", ...contractFields(kind, subject, snapshot, options), head, body, snapshot, summary: `Review ${subject}`, now: new Date(Date.UTC(2026, 0, 1, 0, 0, at)) });
}

async function ownMarked(world: MemoryWorld, n: number): Promise<MarkedComment[]> {
	return filterMarked(await world.forge.listComments(n), BOT_LOGIN).comments;
}

/** A tool harness on a build change with a pending stuck request; the session card is current. */
async function stuckPending(forge?: (world: MemoryWorld) => Forge) {
	const h = await toolHarness({ branch: CHANGE_BRANCH, ...(forge ? { forge } : {}) });
	const n = await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
	await h.world.postComment(n, BOT_LOGIN, writeMarked("stuck", "S1", { where: "U3", tried: [], hypothesis: "h", options: STUCK_OPTIONS, recommended: "A" }));
	const r = request("stuck", "stuck:S1", { id: "S1" }, "", h.head, 1, STUCK_OPTIONS);
	await postRequest(h.world, n, r);
	await h.world.setPermission("alice", "write");
	await h.session.refresh();
	return { ...h, n, r };
}

const LEDGER_NETWORK = new Set(["ls-remote", "fetch", "push"]);
/** A ledger git call that talks to origin; local reads of `refs/livespec/*` are not. */
const isLedgerNetwork = (args: string[]): boolean => LEDGER_NETWORK.has(args[0] ?? "") && args.some((a) => a.includes("refs/livespec/"));

/** A clone of `origin` that appends `input` to change `n` and pushes it, as another machine would. */
async function appendFromOtherClone(origin: string, n: number, input: AppendInput): Promise<void> {
	const clone = join(await mkdtemp(join(tmpdir(), "ls-other-clone-")), "b");
	execFileSync("git", ["clone", "-q", origin, clone]);
	const other = createLedger(defaultGitExec, clone);
	await other.append(n, input);
	expect(await other.sync(n)).toEqual({ status: "synced" });
	await other.background();
}

/** A fresh clone on a build change with a pending `decide:tags.U3` request and a writer's choice; the card read no ledger yet. */
async function decidePending() {
	const h = await toolHarness({ branch: CHANGE_BRANCH });
	const n = await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
	const r = request("stuck", "decide:tags.U3", { point: "tags", subject: "U3", facts: {} }, "", h.head, 1, STUCK_OPTIONS);
	await postRequest(h.world, n, r);
	await h.world.setPermission("alice", "write");
	await h.world.postComment(n, "alice", "/livespec choose A");
	await h.session.refresh({ fetch: false });
	if (h.session.card.kind !== "change") throw new Error("no change card");
	expect(h.session.card.state.requests.pending.map((p) => p.id)).toEqual([r.id]);
	return { h, n, r };
}

describe("pollApprovals", () => {
	test("Answer picked up at session start", async () => {
		const h = await harness({ branch: CHANGE_BRANCH });
		const base = rev(h.root);
		await writeIn(h.root, "specs/rate-limit/spec.md", SPEC);
		commitAll(h.root, "spec");
		const head = rev(h.root);
		const body = resumeBody(base);
		const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: DEFINE_LABELS });
		const r = request("gate", "gate:define", { target: "define", failingWaivable: [] }, body, head, 1);
		await postRequest(h.world, n, r);
		await h.world.setPermission("alice", "write");
		await h.world.postComment(n, "alice", "/livespec approve");

		await h.start();

		const gate = (await ownMarked(h.world, n)).filter((m) => m.kind === "gate");
		expect(gate).toHaveLength(1);
		expect(gate[0]?.data).toMatchObject({ phase: "define", outcome: "approved", adapter: "forge", request: r.id });
		expect((gate[0]?.data as { superseded?: boolean }).superseded).toBeUndefined();
		expect((await h.world.forge.getIssue(n)).labels).toContain("livespec:phase/plan");
	});

	test("Poll failure tolerated", async () => {
		let failing = false;
		const h = await stuckPending((world) =>
			new Proxy(world.forge, {
				get(target, prop, receiver) {
					if (prop === "listComments" && failing) {
						return async () => {
							failing = false;
							throw new Error("transport reset");
						};
					}
					return Reflect.get(target, prop, receiver);
				},
			}),
		);
		failing = true;
		const out = await h.call("spec_status");
		expect(out.isError).toBe(false);
		expect(textOf(out)).toContain("build");
		expect(h.session.errors.join("\n")).toContain("poll: transport reset");
	});

	test("poll skips without pending or applying requests", async () => {
		let lists = 0;
		const h = await toolHarness({
			branch: CHANGE_BRANCH,
			forge: (world) =>
				new Proxy(world.forge, {
					get(target, prop, receiver) {
						if (prop === "listComments") lists++;
						return Reflect.get(target, prop, receiver);
					},
				}),
		});
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.session.refresh();
		const before = lists;
		await pollApprovals(h.session);
		expect(lists).toBe(before);
	});

	test("applying requests are finished before new commands", async () => {
		const h = await stuckPending();
		const applying = request("stuck", "stuck:S0", { id: "S0" }, "", h.head, 2, STUCK_OPTIONS);
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("stuck", "S0", { where: "x", tried: [], hypothesis: "h", options: STUCK_OPTIONS, recommended: "A" }));
		const answered = { status: "answered" as const, outcome: "approved" as const, notes: "", choice: "A", by: "alice", at: "t", adapter: "in-session" as const };
		await h.world.postComment(h.n, BOT_LOGIN, answerComment(applying.id, { request: applying, answer: answered, verdict: "valid" }));
		await h.world.postComment(h.n, "alice", "/livespec choose B");
		await h.session.refresh();

		await pollApprovals(h.session);

		const results = (await ownMarked(h.world, h.n)).filter((m) => m.kind === "stuck" && m.id.endsWith("-answer"));
		expect(results.map((m) => m.id)).toEqual(["S0-answer", "S1-answer"]);
		expect(results[1]?.data).toMatchObject({ choice: "B", request: h.r.id });
	});

	test("concurrent polls complete an answer once", async () => {
		const slow = (world: MemoryWorld): Forge =>
			new Proxy(world.forge, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (typeof value !== "function") return value;
					return async (...args: unknown[]) => {
						await new Promise((r) => setTimeout(r, 2));
						return value.apply(target, args);
					};
				},
			});
		const h = await toolHarness({ branch: CHANGE_BRANCH, forge: slow });
		const body = resumeBody(h.head)
			.replace("- [x] Q1 (blocking)", "- [ ] Q1 (blocking)")
			.replace("Verify: `npm test -- ratelimit`\n- [ ] pending", "Verify: `npm test -- ratelimit`\n- [x] done");
		const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: BUILD_LABELS });
		const locked = Object.fromEntries(parseChange(body).units.map((u) => [u.id, unitDigest(u)]));
		const gate = { phase: "plan", outcome: "approved", notes: "", by: "alice", at: "t", adapter: "in-session", head_sha: h.head, waivers: [], locked };
		await h.world.postComment(n, BOT_LOGIN, writeMarked("gate", "plan.self-1", gate));
		const r = request("question", "question:Q1", { id: "Q1", text: "header?" }, body, h.head, 1);
		await postRequest(h.world, n, r);
		await h.world.setPermission("alice", "write");
		await h.world.postComment(n, "alice", `/livespec answer Q1 X-Forwarded-For`);
		await h.session.refresh();

		await Promise.all([pollApprovals(h.session), pollApprovals(h.session)]);

		const marked = await ownMarked(h.world, n);
		expect(marked.filter((m) => m.kind === "answer")).toHaveLength(1);
		expect(marked.filter((m) => m.kind === "stale")).toHaveLength(0);
		expect(marked.filter((m) => m.kind === "question")).toHaveLength(1);
		if (h.session.card.kind !== "change") throw new Error("no change card");
		expect(h.session.card.state.counters.change_iterations).toBe(0);
	});

	test("a --changes answer leaves the request pending and the card warns", async () => {
		const h = await toolHarness({ branch: CHANGE_BRANCH });
		const body = resumeBody(h.head).replace("- [x] Q1 (blocking)", "- [ ] Q1 (blocking)");
		const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: DEFINE_LABELS });
		await postRequest(h.world, n, request("question", "question:Q1", { id: "Q1", text: "header?" }, body, h.head, 1));
		await h.world.setPermission("alice", "write");
		await h.world.postComment(n, "alice", `/livespec answer Q1 X-Forwarded-For --changes ${REQUIREMENT}`);
		await h.session.refresh();

		await pollApprovals(h.session);

		const marked = await ownMarked(h.world, n);
		expect(marked.filter((m) => m.kind === "answer")).toHaveLength(0);
		expect(h.session.commandWarnings).toEqual([expect.stringContaining("--changes was removed")]);
	});

	test("warnings are reset when the card is not a change", async () => {
		const h = await toolHarness({ branch: "scratch" });
		await h.session.refresh();
		expect(h.session.card.kind).not.toBe("change");
		h.session.commandWarnings = ["ignored /livespec comment 1 by bob: stale"];
		await pollApprovals(h.session);
		expect(h.session.commandWarnings).toEqual([]);
	});

	test("a decide request whose decision is a ledger entry counts as completed", async () => {
		const h = await toolHarness({ branch: CHANGE_BRANCH });
		const n = await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		const r = request("stuck", "decide:tags.U3", { point: "tags", subject: "U3", facts: {} }, "", h.head, 1, STUCK_OPTIONS);
		await postRequest(h.world, n, r);
		await h.world.setPermission("alice", "write");
		await h.session.refresh();
		if (h.session.card.kind !== "change") throw new Error("no change card");
		expect(h.session.card.state.requests.pending.map((p) => p.id)).toEqual([r.id]);
		// Another session completed the request: its decision is in the ledger, which the card has not read yet.
		await h.session.ledger.append(n, { kind: "decision", id: "tags.U3", data: { point: "tags", subject: "U3", source: "human", outcome: "A", reason: "r", request: r.id } });
		await h.world.postComment(n, "alice", "/livespec choose A");

		await pollApprovals(h.session);

		expect((await ownMarked(h.world, n)).filter((m) => m.kind === "answer")).toHaveLength(0);
		if (h.session.card.kind !== "change") throw new Error("no change card");
		expect(h.session.card.state.requests.pending).toEqual([]);
	});

	test("a decision only on origin is fetched before the first tool's poll", async () => {
		const { h, n, r } = await decidePending();
		await appendFromOtherClone(h.origin, n, { kind: "decision", id: "tags.U3", data: { point: "tags", subject: "U3", source: "human", outcome: "A", reason: "r", request: r.id } });

		await h.call("spec_status");

		expect((await ownMarked(h.world, n)).filter((m) => m.kind === "answer")).toHaveLength(0);
		if (h.session.card.kind !== "change") throw new Error("no change card");
		expect(h.session.card.state.requests.pending).toEqual([]);
	});

	test("an unknown ledger while offline skips the poll and records it", async () => {
		const { h, n } = await decidePending();
		h.git("remote", "set-url", "origin", join(tmpdir(), "ls-missing-origin", String(process.pid)));

		await pollApprovals(h.session);

		expect((await ownMarked(h.world, n)).filter((m) => m.kind === "answer")).toHaveLength(0);
		expect(h.session.errors.join("\n")).toContain(`poll: the ledger of #${n} could not be fetched`);
	});

	test("session start shows the card before the ledger fetch, then the poll completes", async () => {
		const hold = deferred<void>();
		const holding = (real: GitExec): GitExec => (args, opts) => (isLedgerNetwork(args) ? hold.promise.then(() => real(args, opts)) : real(args, opts));
		const h = await harness({ branch: CHANGE_BRANCH, sessionGit: holding });
		const n = await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.world.postComment(n, BOT_LOGIN, writeMarked("stuck", "S1", { where: "U3", tried: [], hypothesis: "h", options: STUCK_OPTIONS, recommended: "A" }));
		const r = request("stuck", "stuck:S1", { id: "S1" }, "", h.head, 1, STUCK_OPTIONS);
		await postRequest(h.world, n, r);
		await h.world.setPermission("alice", "write");
		await h.world.postComment(n, "alice", "/livespec choose A");

		await h.startNoWait();

		expect(h.pi.entries.some((e) => e.customType === "livespec-resume")).toBe(true);
		expect(await cardText(h.pi, h.ctx)).toContain("per-ip-cap");
		expect((await ownMarked(h.world, n)).filter((m) => m.kind === "answer")).toHaveLength(0);
		hold.resolve();
		await getSession()?.startInFlight;
		expect((await ownMarked(h.world, n)).filter((m) => m.kind === "answer").map((m) => m.id)).toEqual([r.id]);
	});

	test("ignored commands become card warnings", async () => {
		const h = await stuckPending();
		await h.world.setPermission("bob", "read");
		await h.world.postComment(h.n, "bob", "/livespec choose A");
		await h.session.refresh();

		await pollApprovals(h.session);

		const session = getSession();
		expect(session?.commandWarnings).toHaveLength(1);
		expect(session?.commandWarnings[0]).toContain("lacks write access");
		const card = await cardText(h.pi, h.ctx);
		expect(card).toContain("Ignored commands:");
		expect(card).toContain("lacks write access");
	});
});

describe("/livespec class commands", () => {
	const OPEN_Q2 = "- [ ] Q2 (blocking): Should the window be configurable?";
	const Q2_DONE = "- [x] Q2 (non-blocking): Should the window be configurable? — Answer: yes";
	const q2Line = async (h: { world: MemoryWorld }, n: number) => (await h.world.bodyOf(n)).split("\n").find((l) => l.includes(" Q2 (")) ?? "";
	const classMarks = async (h: { world: MemoryWorld }, n: number) => (await ownMarked(h.world, n)).filter((m) => m.kind === "class");

	/** A define change with a pending blocking question:Q2; alice (write) comments `command`. */
	async function q2Pending(o: { forge?: (world: MemoryWorld) => Forge; nonBlocking?: boolean; command?: string; seed?: (world: MemoryWorld, n: number) => Promise<void> } = {}) {
		const h = await toolHarness({ branch: CHANGE_BRANCH, ...(o.forge ? { forge: o.forge } : {}) });
		const q2 = o.nonBlocking ? OPEN_Q2.replace("(blocking)", "(non-blocking)") : OPEN_Q2;
		const body = resumeBody(h.head).replace(Q2_DONE, q2);
		const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: DEFINE_LABELS });
		await postRequest(h.world, n, request("question", "question:Q2", { id: "Q2", text: "window?" }, body, h.head, 1));
		await h.world.setPermission("alice", "write");
		const commandId = await h.world.postComment(n, "alice", o.command ?? "/livespec class Q2 non-blocking");
		await o.seed?.(h.world, n);
		await h.session.refresh();
		return { ...h, n, commandId };
	}

	// Scenario name kept for archive: the class command is no longer applied.
	test("Class command applied once", async () => {
		const h = await q2Pending();
		await pollApprovals(h.session);
		expect(await q2Line(h, h.n)).toBe(OPEN_Q2);
		expect(await classMarks(h, h.n)).toEqual([]);
		expect(getSession()?.commandWarnings.join("\n")).toContain("cannot be parsed");
		expect(await cardText(h.pi, h.ctx)).toContain("cannot be parsed");
	});

	test("Answer with a class", async () => {
		const h = await q2Pending({ command: "/livespec answer Q2 use per-user limits --class non-blocking" });
		await pollApprovals(h.session);
		expect(await q2Line(h, h.n)).toBe(OPEN_Q2);
		expect(parseChange(await h.world.bodyOf(h.n)).questions.find((q) => q.id === "Q2")?.checked).toBe(false);
		expect((await ownMarked(h.world, h.n)).filter((m) => m.kind === "answer")).toEqual([]);
		expect(getSession()?.commandWarnings.join("\n")).toContain("cannot be parsed");
	});

	// Scenario name kept for archive: an own `class` marker written before this rule is ignored.
	test("Class command recorded across sessions", async () => {
		const h = await q2Pending({ seed: async (world, n) => void (await world.postComment(n, BOT_LOGIN, writeMarked("class", "c-old", { question: "Q2", class: "non-blocking" }))) });
		await pollApprovals(h.session);
		expect(await q2Line(h, h.n)).toBe(OPEN_Q2);
		expect(h.session.card.kind).toBe("change");
		expect(h.session.errors).toEqual([]);
		expect(getSession()?.commandWarnings.join("\n")).toContain("cannot be parsed");
	});

	test("Class command already matching", async () => {
		const h = await q2Pending({ nonBlocking: true, command: "/livespec class Q2 blocking" });
		await pollApprovals(h.session);
		expect(await q2Line(h, h.n)).toContain("Q2 (non-blocking)");
		expect(await classMarks(h, h.n)).toEqual([]);
	});

	// Scenario name kept for archive: a class command never writes the issue body.
	test("Class rewrite conflict retried", async () => {
		let writes = 0;
		const h = await q2Pending({
			forge: (world) =>
				new Proxy(world.forge, {
					get(target, prop, receiver) {
						if (prop !== "updateIssueBody") return Reflect.get(target, prop, receiver);
						return async (n: number, body: string, expect: never) => (writes++, target.updateIssueBody(n, body, expect));
					},
				}),
		});
		const before = await h.world.bodyOf(h.n);
		await pollApprovals(h.session);
		await h.session.refresh();
		await pollApprovals(h.session);
		expect(writes).toBe(0);
		expect(await h.world.bodyOf(h.n)).toBe(before);
	});
});
