import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import { getSession, setSession } from "../../src/hooks/session-store.ts";
import type { RequestRecord, RequestSnapshot } from "../../src/interaction/approver.ts";
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
const STUCK_OPTIONS = [{ id: "A", label: "retry" }, { id: "B", label: "re-plan" }];

const rev = (root: string, ref = "HEAD") => execFileSync("git", ["rev-parse", ref], { cwd: root, encoding: "utf8" }).trim();

async function postRequest(world: MemoryWorld, n: number, r: RequestRecord): Promise<void> {
	await world.postComment(n, BOT_LOGIN, requestComment(r.id, r, "plain text"));
}

function request(kind: RequestRecord["kind"], subject: string, snapshot: RequestSnapshot, body: string, head: string, at: number, options?: RequestRecord["options"]): RequestRecord {
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
		const r = request("gate", "gate:define", { target: "define", digests: {}, failingWaivable: [] }, body, head, 1);
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
