import { describe, expect, test } from "vitest";
import { filterMarked, parseMarked } from "../../src/forge/markers.ts";
import type { Comment, Forge } from "../../src/forge/types.ts";
import type { ApprovalRequest, RequestKind, RequestMode, RequestOption, RequestSnapshot } from "../../src/interaction/approver.ts";
import { runChain } from "../../src/interaction/chain.ts";
import { commandAuthors, createForgeApprover, DuplicateRequestError, matchCommands, type Permission, readPermissions } from "../../src/interaction/forge.ts";
import { answerComment, type PendingRequest, prepareRequest, readRequests, requestComment } from "../../src/interaction/requests.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";

const DEFINE_LABELS = ["livespec", "livespec:phase/define"];
const HEAD = "f".repeat(40);
const NOW = new Date("2026-01-01T00:00:00.000Z");

type Spec = { kind?: RequestKind; subject: string; mode?: RequestMode; options?: RequestOption[]; snapshot?: RequestSnapshot; now?: Date };

function approval(s: Spec): ApprovalRequest {
	const kind = s.kind ?? "gate";
	const record = prepareRequest({
		kind,
		subject: s.subject,
		mode: s.mode ?? "blocking",
		...(s.options ? { options: s.options } : {}),
		head: HEAD,
		body: "body",
		snapshot: s.snapshot ?? { target: s.subject.slice(5), digests: {}, failingWaivable: [] },
		summary: `Review ${s.subject}`,
		now: s.now ?? NOW,
	});
	return { id: record.id, kind, subject: s.subject, record, change: 1, phase: "define", summary: record.summary, links: [], files: [], mode: record.mode, ...(s.options ? { options: s.options } : {}) };
}

async function setup() {
	const world = new MemoryWorld();
	const n = await world.seedIssue({ title: "per-ip-cap", body: "body", labels: DEFINE_LABELS });
	const approver = createForgeApprover(world.forge, n);
	return { world, n, approver };
}

async function pendingOf(world: MemoryWorld, n: number): Promise<PendingRequest[]> {
	return readRequests(filterMarked(await world.forge.listComments(n), BOT_LOGIN).comments).pending;
}

function comment(id: string, author: string, body: string, createdAt: string): Comment {
	return { id, author, body, createdAt, updatedAt: createdAt, version: "cv:1" as Comment["version"] };
}

function pending(subject: string, extra: Partial<PendingRequest["data"]> = {}, kind: RequestKind = "gate"): PendingRequest {
	const r = approval({ subject, kind, ...(extra.options ? { options: extra.options } : {}) });
	const data = { ...r.record, ...extra };
	return { id: data.id, subject, kind, mode: data.mode, createdAt: NOW.toISOString(), data };
}

const LATER = "2026-01-01T00:01:00.000Z";
const writers = (...logins: string[]): Map<string, Permission> => new Map(logins.map((l) => [l, "write" as Permission]));

/** The own request comment of `r`, posted when the request was made. */
function posted(r: PendingRequest, i: number): Comment {
	return comment(`r${i}`, BOT_LOGIN, requestComment(r.id, r.data, "instructions"), r.createdAt);
}

/** Matches `thread` (request comments then commands, unless given in another order) with its own marked comments. */
function matchThread(pending: PendingRequest[], commands: Comment[], perms: ReadonlyMap<string, Permission>, thread = [...pending.map(posted), ...commands]) {
	return matchCommands(pending, thread, perms, { marked: filterMarked(thread, BOT_LOGIN).comments });
}

describe("forge adapter", () => {
	test("Pending gate request", async () => {
		const { world, n, approver } = await setup();
		const result = await runChain(["forge"], { forge: approver }, approval({ subject: "gate:plan" }), { onDeferred: async () => {} });
		expect(result).toMatchObject({ status: "pending" });
		const requests = await pendingOf(world, n);
		expect(requests.map((r) => r.subject)).toEqual(["gate:plan"]);
		expect((await world.forge.getIssue(n)).labels).toEqual(DEFINE_LABELS);
	});

	test("Duplicate request refused", async () => {
		const { world, n, approver } = await setup();
		const first = approval({ subject: "gate:plan" });
		await approver.request(first);
		const before = (await world.forge.listComments(n)).length;
		const second = approval({ subject: "gate:plan", now: new Date(NOW.getTime() + 5000) });
		const refusal = approver.request(second);
		await expect(refusal).rejects.toBeInstanceOf(DuplicateRequestError);
		await expect(refusal).rejects.toThrow(first.record.id);
		expect((await world.forge.listComments(n)).length).toBe(before);
	});

	test("Approve by a writer", async () => {
		const { world, n, approver } = await setup();
		const r = approval({ subject: "gate:define" });
		await approver.request(r);
		await world.setPermission("alice", "write");
		await world.postComment(n, "alice", "/livespec approve looks good");
		const answer = await approver.poll(r.record.id);
		expect(answer).toMatchObject({ status: "answered", outcome: "approved_with_notes", notes: "looks good", by: "alice", adapter: "forge" });
	});

	test("Command without write access ignored", () => {
		const out = matchThread([pending("gate:define")], [comment("9", "bob", "/livespec approve", LATER)], new Map([["bob", "read"]]));
		expect(out.matches).toEqual([]);
		expect(out.warnings).toHaveLength(1);
		expect(out.warnings[0]).toContain("lacks write access");
	});

	test("Command before the request ignored", () => {
		const gate = pending("gate:define");
		const early = comment("9", "alice", "/livespec approve", "2025-12-31T23:59:00.000Z");
		const out = matchThread([gate], [early], writers("alice"), [early, posted(gate, 0)]);
		expect(out.matches).toEqual([]);
		expect(out.warnings[0]).toContain("created before the request");
	});

	test("Answer that changes a requirement", () => {
		const q = pending("question:Q2", { snapshot: { id: "Q2", text: "limits?", requirements: [] } }, "question");
		const body = "/livespec answer Q2 use per-user limits --changes rate-limit/Requirement: Per-IP cap";
		const out = matchThread([q], [comment("9", "alice", body, LATER)], writers("alice"));
		expect(out.matches).toHaveLength(1);
		expect(out.matches[0]?.answer).toMatchObject({ answer: "use per-user limits", changesRequirement: "rate-limit/Requirement: Per-IP cap" });
	});

	test("approve with a pending stuck and an async question is ambiguous only between gate-like requests", () => {
		const stuck = pending("stuck:S1", { options: [{ id: "A", label: "a" }, { id: "B", label: "b" }] }, "stuck");
		const question = pending("question:Q3", { mode: "async", snapshot: { id: "Q3", text: "x", requirements: [] } }, "question");
		const gate = pending("gate:plan");
		const approve = [comment("9", "alice", "/livespec approve", LATER)];

		const one = matchThread([stuck, question, gate], approve, writers("alice"));
		expect(one.matches.map((m) => m.request.subject)).toEqual(["gate:plan"]);
		expect(one.warnings).toEqual([]);

		const amend = pending("amend:1");
		const two = matchThread([stuck, question, gate, amend], approve, writers("alice"));
		expect(two.matches).toEqual([]);
		expect(two.warnings[0]).toContain("ambiguous between gate:plan, amend:1");

		const none = matchThread([stuck, question], approve, writers("alice"));
		expect(none.matches).toEqual([]);
		expect(none.warnings[0]).toContain("approve cannot answer stuck:S1");
	});

	test("approve with failing waivable checks is ignored with a waive hint", () => {
		const gate = pending("gate:plan", { options: [{ id: "waive", label: "waive size-limits" }], snapshot: { target: "plan", digests: {}, failingWaivable: ["size-limits"] } });
		const out = matchThread([gate], [comment("9", "alice", "/livespec approve", LATER)], writers("alice"));
		expect(out.matches).toEqual([]);
		expect(out.warnings[0]).toContain("choose waive");
		const waived = matchThread([gate], [comment("10", "alice", "/livespec choose waive", LATER)], writers("alice"));
		expect(waived.matches[0]?.answer).toMatchObject({ outcome: "approved", choice: "waive" });
	});

	test("getPermission is called once per author", async () => {
		const { world, n } = await setup();
		const calls: string[] = [];
		const counting: Forge = new Proxy(world.forge, {
			get(target, prop, receiver) {
				if (prop === "getPermission") return async (login: string) => (calls.push(login), target.getPermission(login));
				return Reflect.get(target, prop, receiver);
			},
		});
		const approver = createForgeApprover(counting, n);
		const r = approval({ subject: "gate:define" });
		await approver.request(r);
		await world.setPermission("alice", "read");
		await world.postComment(n, "alice", "/livespec approve");
		await world.postComment(n, "alice", "/livespec approve again");
		await world.postComment(n, "bob", "/livespec dismiss");
		await approver.poll(r.record.id);
		expect(calls).toEqual(["alice", "bob"]);
	});

	test("poll returns the matched answer", async () => {
		const { world, n, approver } = await setup();
		const r = approval({ subject: "gate:define" });
		await approver.request(r);
		expect(await approver.poll(r.record.id)).toEqual({ status: "pending" });
		await world.setPermission("alice", "admin");
		const id = await world.postComment(n, "alice", "/livespec changes tighten the proposal");
		const answer = await approver.poll(r.record.id);
		expect(answer).toMatchObject({ status: "answered", outcome: "changes_requested", notes: "tighten the proposal", answerComment: { id, author: "alice" } });
	});

	test("request comment round-trips the prepared record", async () => {
		const { world, n, approver } = await setup();
		const r = approval({ subject: "gate:plan", options: [{ id: "waive", label: "waive size-limits" }], snapshot: { target: "plan", digests: { U1: "abc" }, failingWaivable: ["size-limits"] } });
		await approver.request(r);
		const [posted] = await world.forge.listComments(n);
		const parsed = parseMarked(posted?.body ?? "");
		expect(parsed?.kind).toBe("request");
		expect(parsed?.id).toBe(r.record.id);
		expect({ ...(parsed?.data as object), id: parsed?.id }).toEqual(r.record);
		expect(posted?.body).toContain("/livespec choose <option-id> [notes]");
		expect(posted?.body).toContain("Review gate:plan");
	});

	test("an ambiguous command stays ignored after one of its targets is answered", async () => {
		const { world, n, approver } = await setup();
		const plan = approval({ subject: "gate:plan" });
		const amend = approval({ subject: "amend:1", now: new Date(NOW.getTime() + 1000) });
		await approver.request(plan);
		await approver.request(amend);
		await world.setPermission("alice", "write");
		await world.postComment(n, "alice", "/livespec approve");
		const answered = { status: "answered" as const, outcome: "approved" as const, notes: "", by: "alice", at: "t", adapter: "in-session" as const };
		await world.postComment(n, BOT_LOGIN, answerComment(amend.record.id, { request: amend.record, answer: answered, verdict: "valid" }));

		const all = await world.forge.listComments(n);
		const marked = filterMarked(all, BOT_LOGIN).comments;
		const out = matchCommands(readRequests(marked).pending, all, writers("alice"), { marked });
		expect(out.matches).toEqual([]);
		expect(out.warnings[0]).toContain("ambiguous between gate:plan, amend:1");
		expect(await approver.poll(plan.record.id)).toEqual({ status: "pending" });
	});

	test("a command after its target was answered in the same pass is warned", () => {
		const gate = pending("gate:define");
		const out = matchThread([gate], [comment("9", "alice", "/livespec approve", LATER), comment("10", "bob", "/livespec changes no", LATER)], writers("alice", "bob"));
		expect(out.matches).toHaveLength(1);
		expect(out.warnings).toEqual([expect.stringContaining("already answered by 9")]);
	});

	test("a command for a request answered by an earlier poll is warned", async () => {
		const { world, n, approver } = await setup();
		const r = approval({ subject: "gate:define" });
		await approver.request(r);
		await world.setPermission("alice", "write");
		await world.setPermission("bob", "write");
		const first = await world.postComment(n, "alice", "/livespec approve");
		await world.postComment(n, "bob", "/livespec changes no");
		const polled = await approver.poll(r.record.id);
		if (polled.status !== "answered") throw new Error("not answered");
		await world.postComment(n, BOT_LOGIN, answerComment(r.record.id, { request: r.record, answer: polled, verdict: "valid" }));
		const all = await world.forge.listComments(n);
		const marked = filterMarked(all, BOT_LOGIN).comments;
		const out = matchCommands(readRequests(marked).pending, all, writers("alice", "bob"), { marked });
		expect(out.matches).toEqual([]);
		expect(out.warnings).toEqual([expect.stringContaining(`already answered by ${first}`)]);
	});

	test("a writer's command answered before the earliest pending request is warned as already answered", async () => {
		const { world, n, approver } = await setup();
		const define = approval({ subject: "gate:define" });
		await approver.request(define);
		await world.setPermission("alice", "write");
		await world.setPermission("bob", "write");
		const first = await world.postComment(n, "alice", "/livespec approve");
		const late = await world.postComment(n, "bob", "/livespec approve");
		const polled = await approver.poll(define.record.id);
		if (polled.status !== "answered") throw new Error("not answered");
		await world.postComment(n, BOT_LOGIN, answerComment(define.record.id, { request: define.record, answer: polled, verdict: "valid" }));
		await approver.request(approval({ subject: "gate:plan", now: new Date(NOW.getTime() + 5000) }));

		const all = await world.forge.listComments(n);
		const marked = filterMarked(all, BOT_LOGIN).comments;
		const pendingNow = readRequests(marked).pending;
		const { perms } = await readPermissions(world.forge, commandAuthors(all, pendingNow));
		const out = matchCommands(pendingNow, all, perms, { marked });
		expect(out.matches).toEqual([]);
		expect(out.warnings).toEqual([`ignored /livespec comment ${late} by bob: gate:define was already answered by ${first}`]);
	});

	test("command authors are read only after the earliest pending request", async () => {
		const { world, n, approver } = await setup();
		await world.postComment(n, "carol", "/livespec approve");
		const r = approval({ subject: "gate:define" });
		await approver.request(r);
		await world.postComment(n, "alice", "/livespec approve");
		const all = await world.forge.listComments(n);
		const marked = filterMarked(all, BOT_LOGIN).comments;
		expect(commandAuthors(all, readRequests(marked).pending)).toEqual(["alice"]);
	});

	test("a failing permission lookup counts as no access and spares other authors", async () => {
		const failing = { getPermission: async (login: string): Promise<Permission> => {
			if (login === "eve") throw new Error("boom");
			return "write";
		} };
		const read = await readPermissions(failing, ["eve", "alice"]);
		expect(read.perms.get("eve")).toBe("none");
		expect(read.perms.get("alice")).toBe("write");
		expect(read.warnings).toEqual([expect.stringContaining("eve")]);
		const gate = pending("gate:define");
		const out = matchThread([gate], [comment("9", "eve", "/livespec changes x", LATER), comment("10", "alice", "/livespec approve", LATER)], read.perms);
		expect(out.matches[0]?.answer).toMatchObject({ by: "alice", outcome: "approved" });
	});

	test("Duplicate request refused while the subject is applying", async () => {
		const { world, n, approver } = await setup();
		const first = approval({ subject: "gate:plan" });
		await approver.request(first);
		const answered = { status: "answered" as const, outcome: "approved" as const, notes: "", by: "alice", at: "t", adapter: "in-session" as const };
		await world.postComment(n, BOT_LOGIN, answerComment(first.record.id, { request: first.record, answer: answered, verdict: "valid" }));
		const before = (await world.forge.listComments(n)).length;
		const second = approval({ subject: "gate:plan", now: new Date(NOW.getTime() + 5000) });
		await expect(approver.request(second)).rejects.toThrow(first.record.id);
		expect((await world.forge.listComments(n)).length).toBe(before);
	});
});
