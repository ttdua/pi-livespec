import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseChange, type Unit } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { CommentsCache } from "../../src/engine/comments-cache.ts";
import { createGit } from "../../src/engine/git.ts";
import { readChangeSnapshot, type SnapshotDeps } from "../../src/engine/snapshot.ts";
import { CachedForge } from "../../src/forge/cache.ts";
import { ForgeError } from "../../src/forge/errors.ts";
import { writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import { requestComment } from "../../src/interaction/requests.ts";
import { FIXTURE_BODY } from "../helpers/change-state.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN, OTHER_LOGIN } from "../forge/world.ts";

const BUILD_LABELS = ["livespec", "livespec:phase/build"];

let dir: string;
let world: MemoryWorld;
let root: string;
let base: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ls-snapshot-"));
	world = new MemoryWorld();
	root = await makeRepo();
	await writeIn(root, "README.md", "x\n");
	commitAll(root);
	base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function deps(forge: Forge = world.forge, isReadOnly = () => false): SnapshotDeps {
	return { forge, isReadOnly, git: createGit(root), comments: new CommentsCache({ dir: join(dir, "comments") }), iterationCap: 5 };
}

const U2_BLOCK = "### U2 — Header parsing\nCovers: request-context/Requirement: Client IP\nDifficulty: low\nTags: []\nFiles: src/headers.ts\nDone means:\n- [hdr] the forwarded header is parsed\nScenarios:\n- [hdr] test/headers.test.ts › parses header\nDepends: U1\nVerify: `npm test -- headers`\n- [ ] pending\n\n";

function withBase(body: string, sha: string | undefined): string {
	return sha === undefined ? body.replace(/^Base: .*\n/m, "") : body.replace(/^Base: .*$/m, `Base: ${sha}`);
}

describe("readChangeSnapshot", () => {
	test("State from fixture issue", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: FIXTURE_BODY, labels: BUILD_LABELS });
		await writeIn(root, "dirty.txt", "y\n");
		const state = await readChangeSnapshot(deps(), n);
		expect(state.phase).toEqual({ kind: "ok", id: "build" });
		expect(state.change.units.map((u) => [u.id, u.done])).toEqual([
			["U1", true],
			["U3", false],
		]);
		expect(state.git.dirty).toBe(true);
		expect(state.issue).toEqual({ number: n, title: "per-ip-cap", labels: BUILD_LABELS });
		expect(state.sections).toEqual({ Capabilities: true, Proposal: true, Design: true, Units: true });
		expect(state.stale).toBe(false);
		expect(state.readOnly).toBe(false);
	});

	test("Stale state", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: FIXTURE_BODY, labels: BUILD_LABELS });
		await world.postComment(n, BOT_LOGIN, writeMarked("counter", "review_rounds", { value: 2 }));
		const forge = new CachedForge(world.forge, { cacheRoot: join(dir, "issues"), host: "h", owner: "o", repo: "r" });
		const d = deps(forge, () => forge.isReadOnly());
		await readChangeSnapshot(d, n);
		await world.makeUnreachable();
		const state = await readChangeSnapshot(d, n);
		expect(state.stale).toBe(true);
		expect(state.readOnly).toBe(true);
		expect(state.phase).toEqual({ kind: "ok", id: "build" });
		expect(state.change.units).toHaveLength(2);
	});

	test("offline with no known login reads no own comments and warns", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: withBase(FIXTURE_BODY, base), labels: BUILD_LABELS });
		await world.postComment(n, BOT_LOGIN, writeMarked("counter", "review_rounds", { value: 2 }));
		const warm = new CachedForge(world.forge, { cacheRoot: join(dir, "issues"), host: "h", owner: "o", repo: "r" });
		const comments = new CommentsCache({ dir: join(dir, "comments") });
		await readChangeSnapshot({ ...deps(warm), comments }, n);
		await world.makeUnreachable();
		// A new forge instance (new session) has never seen the login.
		const fresh = new CachedForge(world.forge, { cacheRoot: join(dir, "issues"), host: "h", owner: "o", repo: "r" });
		const state = await readChangeSnapshot({ ...deps(fresh, () => fresh.isReadOnly()), comments }, n);
		expect(state.stale).toBe(true);
		expect(state.counters).toEqual({ change_iterations: 0 });
		expect(state.warnings).toEqual([expect.stringContaining("login is unknown")]);
	});

	test("account switch then unreachable whoami does not reuse the previous login", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: withBase(FIXTURE_BODY, base), labels: BUILD_LABELS });
		await world.postComment(n, BOT_LOGIN, writeMarked("counter", "review_rounds", { value: 2 }));
		await world.postComment(n, BOT_LOGIN, writeMarked("incomplete", "U3", { reason: "r" }));
		let whoamiFails = false;
		const forge = new Proxy(world.forge, {
			get(t, key, receiver) {
				if (key === "whoami" && whoamiFails) {
					return () => Promise.reject(new ForgeError({ code: "unreachable", operation: "whoami", message: "down" }));
				}
				const value = Reflect.get(t, key, receiver);
				return typeof value === "function" ? value.bind(t) : value;
			},
		});
		const d = deps(forge);
		expect((await readChangeSnapshot(d, n)).counters).toEqual({ review_rounds: 2, change_iterations: 0 });
		// The account switches; whoami can no longer confirm who is logged in.
		whoamiFails = true;
		const state = await readChangeSnapshot(d, n);
		expect(state.counters).toEqual({ change_iterations: 0 });
		expect(state.incomplete).toEqual([]);
		expect(state.stale).toBe(true);
		expect(state.warnings).toEqual([expect.stringContaining("login is unknown")]);
	});

	test("Ambiguous phase", async () => {
		const labels = ["livespec", "livespec:phase/define", "livespec:phase/plan"];
		const n = await world.seedIssue({ title: "per-ip-cap", body: FIXTURE_BODY, labels });
		const state = await readChangeSnapshot(deps(), n);
		expect(state.phase).toEqual({ kind: "ambiguous", ids: ["define", "plan"] });
	});

	test("missing phase label", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: FIXTURE_BODY, labels: ["livespec"] });
		expect((await readChangeSnapshot(deps(), n)).phase).toEqual({ kind: "missing" });
	});

	test("incomplete markers are collected", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: withBase(FIXTURE_BODY, base), labels: BUILD_LABELS });
		await world.postComment(n, BOT_LOGIN, writeMarked("incomplete", "U3", { reason: "stopped" }));
		await world.postComment(n, BOT_LOGIN, writeMarked("skill-note", "build.debugging-and-error-recovery", { phase: "build", skill: "debugging-and-error-recovery", reason: "r" }));
		await world.postComment(n, BOT_LOGIN, writeMarked("counter", "review_rounds", { value: 2 }));
		await world.postComment(n, OTHER_LOGIN, writeMarked("incomplete", "U1", { reason: "foreign" }));
		const state = await readChangeSnapshot(deps(), n);
		expect(state.incomplete).toEqual(["U3"]);
		expect(state.skillNotes).toEqual(["build.debugging-and-error-recovery"]);
		expect(state.counters).toEqual({ review_rounds: 2, change_iterations: 0 });
		expect(state.warnings).toEqual([expect.stringContaining(`written by ${OTHER_LOGIN}`)]);
	});

	test("specsChanged reflects the diff from Base", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: withBase(FIXTURE_BODY, base), labels: BUILD_LABELS });
		expect((await readChangeSnapshot(deps(), n)).git.specsChanged).toBe(false);
		await writeIn(root, "specs/rate-limit/spec.md", "# rate-limit\n");
		commitAll(root, "spec");
		const state = await readChangeSnapshot(deps(), n);
		expect(state.git.specsChanged).toBe(true);
		expect(state.git.head).not.toBe(base);
		expect(state.git.branch).not.toBe("");
	});

	test("specsChanged is undefined without Base", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: withBase(FIXTURE_BODY, undefined), labels: BUILD_LABELS });
		const state = await readChangeSnapshot(deps(), n);
		expect(state.git.specsChanged).toBeUndefined();
		expect(state.warnings).toEqual([]);
	});

	test("unknown Base leaves specsChanged undefined with a warning", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: FIXTURE_BODY, labels: BUILD_LABELS });
		const state = await readChangeSnapshot(deps(), n);
		expect(state.git.specsChanged).toBeUndefined();
		expect(state.warnings).toEqual([expect.stringContaining("0123456789abcdef0123456789abcdef01234567")]);
	});

	test("sections are absent when empty or undeclared", async () => {
		const body = "Capabilities: new [], modified []\n\n## Proposal\n\n## Design\nSomething.\n\n## Units\n";
		const n = await world.seedIssue({ title: "x", body, labels: ["livespec", "livespec:phase/define"] });
		const state = await readChangeSnapshot(deps(), n);
		expect(state.sections).toEqual({ Capabilities: false, Proposal: false, Design: true, Units: false });
	});
	test("Pending request and lock from comments", async () => {
		const body = FIXTURE_BODY.replace("### U3 —", `${U2_BLOCK}### U3 —`);
		const n = await world.seedIssue({ title: "per-ip-cap", body, labels: BUILD_LABELS });
		const [u1, , u3] = parseChange(body).units.map((u: Unit) => unitDigest(u));
		await world.postComment(n, BOT_LOGIN, writeMarked("gate", "plan.gate-plan.a", { request: "gate-plan.a", phase: "plan", outcome: "approved", notes: "", by: "alice", at: "t", adapter: "forge", head_sha: "f", waivers: [], locked: { U1: u1, U2: "0".repeat(64), U3: u3 } }));
		const record = { id: "question-Q4.b", kind: "question" as const, subject: "question:Q4" as const, mode: "blocking" as const, head_sha: "f", snapshot: { id: "Q4", text: "?", requirements: [] }, summary: "Q4?" };
		await world.postComment(n, BOT_LOGIN, requestComment(record.id, record, "Answer with /livespec answer Q4 <text>."));
		const state = await readChangeSnapshot(deps(), n);
		expect(state.lock.frozen).toEqual(["U2"]);
		expect(state.requests.pending.map((r) => [r.id, r.subject])).toEqual([["question-Q4.b", "question:Q4"]]);
		expect(state.requests.applying).toEqual([]);
		expect(state.marked.map((m) => m.kind)).toEqual(["gate", "request"]);
		expect(state.commandWarnings).toEqual([]);
	});

	test("zero iterations override a stored counter comment", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: withBase(FIXTURE_BODY, base), labels: BUILD_LABELS });
		await world.postComment(n, BOT_LOGIN, writeMarked("counter", "change_iterations", { value: 4 }));
		const state = await readChangeSnapshot(deps(), n);
		expect(state.counters).toEqual({ change_iterations: 0 });
		expect(state.iterations.count).toBe(0);
	});

	test("iterations count overrides the counter value", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: withBase(FIXTURE_BODY, base), labels: BUILD_LABELS });
		await world.postComment(n, BOT_LOGIN, writeMarked("counter", "change_iterations", { value: 9 }));
		await world.postComment(n, BOT_LOGIN, writeMarked("stale", "Q1", { reason: "Q1", phases: ["define"], units: [], after_plan: true }));
		await world.postComment(n, BOT_LOGIN, writeMarked("stale", "Q2", { reason: "Q2", phases: ["define"], units: [], after_plan: true }));
		const state = await readChangeSnapshot(deps(), n);
		expect(state.counters).toEqual({ change_iterations: 2 });
		expect(state.iterations).toEqual({ count: 2, cap: 5, blocking: false, stuckOpen: undefined });
	});
});
