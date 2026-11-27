import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { advancePhase } from "../../src/engine/advance.ts";
import { CommentsCache } from "../../src/engine/comments-cache.ts";
import { defaultGitExec } from "../../src/engine/git-exec.ts";
import { createGit } from "../../src/engine/git.ts";
import { createLedger } from "../../src/ledger/index.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { readChangeSnapshot } from "../../src/engine/snapshot.ts";
import { ForgeError } from "../../src/forge/errors.ts";
import type { Forge } from "../../src/forge/types.ts";
import { FIXTURE_BODY } from "../helpers/change-state.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";

const WRITES = new Set(["addLabels", "removeLabels", "updateIssueBody", "createComment", "updateComment", "closeIssue", "reopenIssue"]);

let pack: Pack;
let world: MemoryWorld;
let dir: string;

beforeAll(async () => {
	const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
	if (!loaded.ok) throw new Error("default pack must load");
	pack = loaded.pack;
});

beforeEach(async () => {
	world = new MemoryWorld();
	dir = await mkdtemp(join(tmpdir(), "ls-advance-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

type Spy = { forge: Forge; writes: string[] };

/** The memory forge with write calls recorded; `failRemoveOnce` makes the first `removeLabels` throw. */
function spy(failRemoveOnce = false): Spy {
	const writes: string[] = [];
	let failNext = failRemoveOnce;
	const target = world.forge;
	const forge = new Proxy(target, {
		get(t, key, receiver) {
			const value = Reflect.get(t, key, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (typeof key === "string" && WRITES.has(key)) writes.push(key);
				if (key === "removeLabels" && failNext) {
					failNext = false;
					return Promise.reject(new ForgeError({ code: "http", operation: "removeLabels", message: "boom", status: 500 }));
				}
				return (value as (...a: unknown[]) => unknown).apply(t, args);
			};
		},
	});
	return { forge, writes };
}

async function issueWith(...phases: string[]): Promise<number> {
	return world.seedIssue({ title: "per-ip-cap", body: FIXTURE_BODY, labels: ["livespec", ...phases.map((p) => `livespec:phase/${p}`)] });
}

async function labels(n: number): Promise<string[]> {
	return (await world.forge.getIssue(n)).labels;
}

describe("advancePhase", () => {
	test("Forward move", async () => {
		const n = await issueWith("define");
		expect(await advancePhase(world.forge, n, "plan", pack)).toEqual({ status: "moved", from: "define" });
		expect(await labels(n)).toEqual(["livespec", "livespec:phase/plan"]);
	});

	test("Skip refused", async () => {
		const n = await issueWith("define");
		const { forge, writes } = spy();
		const result = await advancePhase(forge, n, "build", pack);
		expect(result).toEqual({ status: "refused", reason: "cannot move from define to build: build does not follow define and is not an earlier phase" });
		expect(writes).toEqual([]);
		expect(await labels(n)).toEqual(["livespec", "livespec:phase/define"]);
	});

	test("backward move allowed", async () => {
		const n = await issueWith("build");
		expect(await advancePhase(world.forge, n, "define", pack)).toEqual({ status: "moved", from: "build" });
		expect(await labels(n)).toEqual(["livespec", "livespec:phase/define"]);
	});

	test("unknown target is refused", async () => {
		const n = await issueWith("define");
		expect(await advancePhase(world.forge, n, "deploy", pack)).toEqual({ status: "refused", reason: "deploy is not a phase of the flow pack" });
	});

	test("Partial failure", async () => {
		const n = await issueWith("define");
		const { forge, writes } = spy(true);
		await expect(advancePhase(forge, n, "plan", pack)).rejects.toThrow("boom");
		expect(writes).toEqual(["addLabels", "removeLabels"]);
		expect(await labels(n)).toEqual(["livespec", "livespec:phase/define", "livespec:phase/plan"]);
		const root = await makeRepo();
		await writeIn(root, "README.md", "x\n");
		commitAll(root);
		const comments = new CommentsCache({ dir: join(dir, "comments") });
		const state = await readChangeSnapshot({ forge: world.forge, ledger: createLedger(defaultGitExec, root), fetch: false, isReadOnly: () => false, git: createGit(root), comments }, n);
		expect(state.phase).toEqual({ kind: "ambiguous", ids: ["define", "plan"] });
	});

	test("Normal move unaffected", async () => {
		const n = await issueWith("define");
		const { forge, writes } = spy();
		expect(await advancePhase(forge, n, "plan", pack)).toEqual({ status: "moved", from: "define" });
		expect(writes).toEqual(["addLabels", "removeLabels"]);
	});

	test("Retry completes the move", async () => {
		const n = await issueWith("define", "plan");
		const { forge, writes } = spy();
		expect(await advancePhase(forge, n, "plan", pack)).toEqual({ status: "moved", from: "define" });
		expect(writes).toEqual(["removeLabels"]);
		expect(await labels(n)).toEqual(["livespec", "livespec:phase/plan"]);
	});

	test("Already moved", async () => {
		const n = await issueWith("plan");
		const { forge, writes } = spy();
		expect(await advancePhase(forge, n, "plan", pack)).toEqual({ status: "unchanged" });
		expect(writes).toEqual([]);
	});

	test("Three phase labels", async () => {
		const n = await issueWith("define", "plan", "build");
		const { forge, writes } = spy();
		const result = await advancePhase(forge, n, "plan", pack);
		expect(result.status).toBe("refused");
		expect(result).toHaveProperty("reason", expect.stringContaining("keep exactly one livespec:phase/* label"));
		expect(writes).toEqual([]);
		expect(await labels(n)).toEqual(["livespec", "livespec:phase/define", "livespec:phase/plan", "livespec:phase/build"]);
	});

	test("no phase label is refused with a repair hint", async () => {
		const n = await issueWith();
		const result = await advancePhase(world.forge, n, "plan", pack);
		expect(result).toHaveProperty("reason", expect.stringContaining("keep exactly one livespec:phase/* label"));
	});
});

describe("advancePhase merged", () => {
	test("Merged pull request moves to close", async () => {
		const n = await issueWith("review");
		expect(await advancePhase(world.forge, n, "close", pack, { merged: true })).toEqual({ status: "moved", from: "review" });
		expect(await labels(n)).toEqual(["livespec", "livespec:phase/close"]);
	});

	test("merged jump works from the earliest phase", async () => {
		const n = await issueWith("define");
		expect(await advancePhase(world.forge, n, "close", pack, { merged: true })).toEqual({ status: "moved", from: "define" });
	});

	test("Close without merge refused", async () => {
		const n = await issueWith("review");
		const { forge, writes } = spy();
		const result = await advancePhase(forge, n, "close", pack);
		expect(result.status).toBe("refused");
		expect(writes).toEqual([]);
		expect(await advancePhase(forge, n, "close", pack, { merged: false })).toHaveProperty("status", "refused");
	});

	test("merged flag does not open other jumps", async () => {
		const n = await issueWith("define");
		expect(await advancePhase(world.forge, n, "build", pack, { merged: true })).toHaveProperty("status", "refused");
	});
});
