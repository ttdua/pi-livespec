import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { createGit } from "../../src/engine/git.ts";
import { Session } from "../../src/hooks/session.ts";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import { getSession, setSession } from "../../src/hooks/session-store.ts";
import type { RequestRecord, RequestSnapshot, Subject } from "../../src/interaction/approver.ts";
import { pollApprovals } from "../../src/interaction/poll.ts";
import { answerComment, prepareRequest, requestComment } from "../../src/interaction/requests.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { CHANGE_BRANCH, cardText, cleanupHomes, harness, resumeBody } from "../hooks/helpers.ts";
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
	return prepareRequest({ kind, subject, mode: "blocking", ...(options ? { options } : {}), head, body, snapshot, summary: `Review ${subject}`, now: new Date(Date.UTC(2026, 0, 1, 0, 0, at)) });
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
		const r = request("question", "question:Q1", { id: "Q1", text: "header?", requirements: [REQUIREMENT] }, body, h.head, 1);
		await postRequest(h.world, n, r);
		await h.world.setPermission("alice", "write");
		await h.world.postComment(n, "alice", `/livespec answer Q1 X-Forwarded-For --changes ${REQUIREMENT}`);
		await h.session.refresh();

		await Promise.all([pollApprovals(h.session), pollApprovals(h.session)]);

		const marked = await ownMarked(h.world, n);
		expect(marked.filter((m) => m.kind === "answer")).toHaveLength(1);
		expect(marked.filter((m) => m.kind === "stale")).toHaveLength(1);
		expect(marked.filter((m) => m.kind === "question")).toHaveLength(1);
		if (h.session.card.kind !== "change") throw new Error("no change card");
		expect(h.session.card.state.counters.change_iterations).toBe(1);
	});

	test("warnings are reset when the card is not a change", async () => {
		const h = await toolHarness({ branch: "scratch" });
		await h.session.refresh();
		expect(h.session.card.kind).not.toBe("change");
		h.session.commandWarnings = ["ignored /livespec comment 1 by bob: stale"];
		await pollApprovals(h.session);
		expect(h.session.commandWarnings).toEqual([]);
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

	/** A define change with a pending blocking question:Q2; alice has write and has not commented yet. */
	async function q2Pending(o: { forge?: (world: MemoryWorld) => Forge; closed?: boolean; nonBlocking?: boolean } = {}) {
		const h = await toolHarness({ branch: CHANGE_BRANCH, ...(o.forge ? { forge: o.forge } : {}) });
		const q2 = o.closed ? Q2_DONE : o.nonBlocking ? OPEN_Q2.replace("(blocking)", "(non-blocking)") : OPEN_Q2;
		const body = resumeBody(h.head).replace(Q2_DONE, q2);
		const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: DEFINE_LABELS });
		await postRequest(h.world, n, request("question", "question:Q2", { id: "Q2", text: "window?", requirements: [REQUIREMENT] }, body, h.head, 1));
		await h.world.setPermission("alice", "write");
		const commandId = await h.world.postComment(n, "alice", "/livespec class Q2 non-blocking");
		await h.session.refresh();
		return { ...h, n, commandId };
	}
	const backToBlocking = async (h: { world: MemoryWorld; n: number }) =>
		h.world.editBodyBehindBack(h.n, (await h.world.bodyOf(h.n)).replace("Q2 (non-blocking)", "Q2 (blocking)"));

	test("Class command applied once", async () => {
		const h = await q2Pending();
		await pollApprovals(h.session);
		expect(await q2Line(h, h.n)).toContain("Q2 (non-blocking)");
		const marks = await classMarks(h, h.n);
		expect(marks).toHaveLength(1);
		expect(marks[0]).toMatchObject({ id: h.commandId, data: { question: "Q2", class: "non-blocking" } });

		await backToBlocking(h);
		await h.session.refresh();
		await pollApprovals(h.session);
		expect(await q2Line(h, h.n)).toContain("Q2 (blocking)");
		expect(await classMarks(h, h.n)).toHaveLength(1);
	});

	test("a recorded class command needs no permission lookup", async () => {
		const asked: string[] = [];
		const h = await q2Pending({
			forge: (world) =>
				new Proxy(world.forge, {
					get(target, prop, receiver) {
						if (prop !== "getPermission") return Reflect.get(target, prop, receiver);
						return async (login: string) => (asked.push(login), target.getPermission(login));
					},
				}),
		});
		await pollApprovals(h.session);
		expect(await classMarks(h, h.n)).toHaveLength(1);
		expect(asked).toContain("alice");
		asked.length = 0;
		await h.session.refresh();
		await pollApprovals(h.session);
		expect(asked).not.toContain("alice");
	});

	test("Class command already matching", async () => {
		const h = await q2Pending({ nonBlocking: true });
		await pollApprovals(h.session);
		expect(await classMarks(h, h.n)).toHaveLength(1);

		await backToBlocking(h);
		await h.session.refresh();
		await pollApprovals(h.session);
		expect(await q2Line(h, h.n)).toContain("Q2 (blocking)");
		expect(await classMarks(h, h.n)).toHaveLength(1);
	});

	test("Class rewrite conflict retried", async () => {
		let conflicts = 0;
		const h = await q2Pending({
			forge: (world) =>
				new Proxy(world.forge, {
					get(target, prop, receiver) {
						if (prop !== "updateIssueBody") return Reflect.get(target, prop, receiver);
						return async (n: number, body: string, expect: never) => {
							if (conflicts === 0) {
								conflicts++;
								await world.editBodyBehindBack(n, (await world.bodyOf(n)).replace("Limit each client IP.", "Limit each client IP address."));
							}
							return target.updateIssueBody(n, body, expect);
						};
					},
				}),
		});
		await pollApprovals(h.session);
		expect(conflicts).toBe(1);
		expect(await classMarks(h, h.n)).toHaveLength(0);
		expect(h.session.errors.join("\n")).toContain("the next poll retries");

		await h.session.refresh();
		await pollApprovals(h.session);
		expect(await q2Line(h, h.n)).toContain("Q2 (non-blocking)");
		expect(await classMarks(h, h.n)).toHaveLength(1);
	});

	test("Class command recorded across sessions", async () => {
		const h = await q2Pending();
		await pollApprovals(h.session);
		expect(await classMarks(h, h.n)).toHaveLength(1);
		await backToBlocking(h);

		const fresh = new Session(h.root, createGit(h.root));
		fresh.config = h.session.config;
		fresh.pack = h.session.pack;
		fresh.forge = h.forge;
		setSession(fresh);
		await fresh.refresh();
		await pollApprovals(fresh);

		expect(await q2Line(h, h.n)).toContain("Q2 (blocking)");
		expect(await classMarks(h, h.n)).toHaveLength(1);
	});

	test("class marker write failure applies the command once more", async () => {
		let failures = 0;
		const h = await q2Pending({
			forge: (world) =>
				new Proxy(world.forge, {
					get(target, prop, receiver) {
						if (prop !== "createComment") return Reflect.get(target, prop, receiver);
						return async (n: number, body: string) => {
							if (failures === 0 && body.includes("livespec:class:")) {
								failures++;
								throw new Error("comment write failed");
							}
							return target.createComment(n, body);
						};
					},
				}),
		});
		await pollApprovals(h.session);
		expect(failures).toBe(1);
		expect(await q2Line(h, h.n)).toContain("Q2 (non-blocking)");
		expect(await classMarks(h, h.n)).toHaveLength(0);
		expect(h.session.errors.join("\n")).toContain("comment write failed");

		await h.session.refresh();
		await pollApprovals(h.session);
		expect(await classMarks(h, h.n)).toHaveLength(1);
		expect(await q2Line(h, h.n)).toContain("Q2 (non-blocking)");
	});

	test("class command for a closed question is skipped", async () => {
		const h = await q2Pending({ closed: true });
		const before = await h.world.bodyOf(h.n);
		await pollApprovals(h.session);
		expect(await h.world.bodyOf(h.n)).toBe(before);
		expect(await classMarks(h, h.n)).toHaveLength(0);
	});
});
