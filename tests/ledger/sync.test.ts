import { execFileSync, spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type GitExec, defaultGitExec } from "../../src/engine/git-exec.ts";
import { type AppendInput, LedgerError, entryVersion } from "../../src/ledger/entry.ts";
import { createLedger } from "../../src/ledger/index.ts";
import { appendEntry, readLedger } from "../../src/ledger/store.ts";
import { offline, twoClones } from "./fixtures.ts";

const N = 59;
const LOCAL = `refs/livespec/${N}`;
const TRACKING = `refs/livespec-origin/${N}`;
const exec = defaultGitExec;

function decision(id: string): AppendInput {
	return { kind: "decision", id, data: { answer: id } };
}

function refAt(gitDir: string, ref: string): string | undefined {
	const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: gitDir, encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : undefined;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function refsOf(root: string): Promise<string[]> {
	return (await readLedger(exec, root, N)).entries.map((e) => e.ref).sort();
}

/** An exec that runs `before` once, right before the first git call matching `match`. */
function interceptOnce(match: (args: string[]) => boolean, before: () => Promise<void> | void): GitExec {
	let done = false;
	return async (args, opts) => {
		if (!done && match(args)) {
			done = true;
			await before();
		}
		return defaultGitExec(args, opts);
	};
}

const isPush = (args: string[]) => args[0] === "push" && !args.some((a) => a.startsWith("--force-with-lease"));
const isLocalSwap = (args: string[]) => args[0] === "update-ref" && args.includes(LOCAL) && !args.includes("-d");

/** An exec that holds `refs/livespec/<N>.lock` in `root` during the first `times` local swaps, as a concurrent writer would. */
function lockedSwaps(root: string, times: number): GitExec {
	const lock = join(root, ".git", "refs", "livespec", `${N}.lock`);
	let left = times;
	return async (args, opts) => {
		if (left === 0 || !isLocalSwap(args)) return defaultGitExec(args, opts);
		left--;
		writeFileSync(lock, "");
		try {
			return await defaultGitExec(args, opts);
		} finally {
			rmSync(lock, { force: true });
		}
	};
}

/** Clones a and b with a shared synced D0, then one more entry on each side, so b's sync must replay. */
async function diverged(): Promise<{ remote: string; a: string; b: string }> {
	const clones = await twoClones();
	const seed = createLedger(exec, clones.a);
	await seed.append(N, decision("D0"));
	await seed.background();
	await createLedger(exec, clones.b).ensureFetched(N);
	await appendEntry(exec, clones.a, N, decision("D1"));
	expect(await createLedger(exec, clones.a).sync(N)).toEqual({ status: "synced" });
	await appendEntry(exec, clones.b, N, decision("D2"));
	return clones;
}

describe("ledger sync", () => {
	it("Two machines append concurrently", async () => {
		const { remote, a, b } = await twoClones();
		const seed = createLedger(exec, a);
		await seed.append(N, decision("D0"));
		await seed.background();
		expect(await createLedger(exec, b).ensureFetched(N)).toBe("fetched");
		const base = refAt(a, LOCAL);
		expect(refAt(b, LOCAL)).toBe(base);

		const fromA = await appendEntry(exec, a, N, decision("D1"));
		const fromB = await appendEntry(exec, b, N, decision("D2"));
		// B fetches first; A pushes before B's push, so B's push is rejected and B replays.
		let pushes = 0;
		const execB: GitExec = interceptOnce(isPush, async () => {
			expect(await createLedger(exec, a).sync(N)).toEqual({ status: "synced" });
		});
		const countingB: GitExec = (args, opts) => {
			if (isPush(args)) pushes++;
			return execB(args, opts);
		};
		expect(await createLedger(countingB, b).sync(N)).toEqual({ status: "synced" });
		expect(pushes).toBe(2);
		expect(await createLedger(exec, a).sync(N)).toEqual({ status: "synced" });

		const expected = [fromA.ref, fromB.ref, (await readLedger(exec, a, N)).entries[0]?.ref].sort();
		expect(await refsOf(a)).toEqual(expected);
		expect(await refsOf(b)).toEqual(expected);
		expect(refAt(a, LOCAL)).toBe(refAt(b, LOCAL));
		expect(refAt(remote, LOCAL)).toBe(refAt(a, LOCAL));
		const seqs = (await readLedger(exec, b, N)).entries.map((e) => e.seq);
		expect(seqs).toEqual([1, 2, 3]);
	});

	it("Version kept across a replay", async () => {
		const { a, b } = await twoClones();
		const seed = createLedger(exec, a);
		await seed.append(N, decision("D0"));
		await seed.background();
		await createLedger(exec, b).ensureFetched(N);
		await appendEntry(exec, a, N, decision("D1"));
		expect(await createLedger(exec, a).sync(N)).toEqual({ status: "synced" });
		const before = await appendEntry(exec, b, N, { ...decision("D2"), after: "D1~00000000" });

		expect(await createLedger(exec, b).sync(N)).toEqual({ status: "synced" });
		const after = (await readLedger(exec, b, N)).entries.find((e) => e.ref === before.ref);
		expect(after?.seq).toBe(3);
		expect(before.seq).toBe(2);
		expect(after && entryVersion(after)).toBe(entryVersion(before));
		expect(after).toEqual({ ...before, seq: 3 });
	});

	it("Remote ledger absent", async () => {
		const { remote, a } = await twoClones();
		const ledger = createLedger(exec, a);
		await ledger.append(N, decision("D1"));
		await ledger.background();
		expect(refAt(remote, LOCAL)).toBe(refAt(a, LOCAL));
		expect(refAt(a, TRACKING)).toBe(refAt(a, LOCAL));
		expect(await ledger.pending(N)).toBe(false);
	});

	it("Offline append", async () => {
		const { remote, a } = await twoClones();
		const ledger = createLedger(exec, a);
		await ledger.append(N, decision("D1"));
		await ledger.background();
		offline(a);
		const entry = await ledger.append(N, decision("D2"));
		await ledger.background();
		expect((await readLedger(exec, a, N)).entries.map((e) => e.ref)).toContain(entry.ref);
		const result = await ledger.sync(N);
		expect(result.status).toBe("pending");
		expect(result.status === "pending" && result.reason).toBeTruthy();
		expect(await ledger.pending(N)).toBe(true);
		expect(refAt(remote, LOCAL)).not.toBe(refAt(a, LOCAL));
	});

	it("Pending entries pushed later", async () => {
		const { remote, a } = await twoClones();
		const first = createLedger(exec, a);
		await first.append(N, decision("D1"));
		await first.background();
		const online = offline(a);
		await first.append(N, decision("D2"));
		await first.background();
		expect(await first.pending(N)).toBe(true);

		online();
		const next = createLedger(exec, a);
		expect(await next.sync(N)).toEqual({ status: "synced" });
		expect(await next.pending(N)).toBe(false);
		expect(refAt(remote, LOCAL)).toBe(refAt(a, LOCAL));
	});

	it("a lock collision on the local swap restarts the sync", async () => {
		const { remote, b } = await diverged();
		expect(await createLedger(lockedSwaps(b, 1), b).sync(N)).toEqual({ status: "synced" });
		expect(refAt(remote, LOCAL)).toBe(refAt(b, LOCAL));
		expect((await readLedger(exec, b, N)).entries.map((e) => e.id)).toEqual(["D0", "D1", "D2"]);
	});

	it("lost swaps beyond the restart budget end pending", async () => {
		const { b } = await diverged();
		const result = await createLedger(lockedSwaps(b, 100), b).sync(N);
		expect(result.status).toBe("pending");
		expect(result.status === "pending" && result.reason).toMatch(/retries used up/);
	});

	it("an append between fetch and swap restarts the sync and keeps both entries", async () => {
		const { remote, b } = await diverged();
		let late = "";
		const execB = interceptOnce(isLocalSwap, async () => {
			late = (await appendEntry(exec, b, N, decision("D3"))).ref;
		});
		expect(await createLedger(execB, b).sync(N)).toEqual({ status: "synced" });
		const entries = (await readLedger(exec, b, N)).entries;
		expect(entries.map((e) => e.id).sort()).toEqual(["D0", "D1", "D2", "D3"]);
		expect(entries.map((e) => e.ref)).toContain(late);
		expect(refAt(remote, LOCAL)).toBe(refAt(b, LOCAL));
	});

	it("two concurrent syncs keep every entry and leave tracking at the final tip", async () => {
		const { remote, b } = await diverged();
		const ledger = createLedger(exec, b);
		const results = await Promise.all([ledger.sync(N), ledger.sync(N)]);
		// Both fetches may race on the tracking ref lock; the loser ends pending (left as is, Minor 6).
		expect(results.map((r) => r.status).every((s) => s === "synced" || s === "pending")).toBe(true);
		expect(results.map((r) => r.status)).toContain("synced");
		expect((await readLedger(exec, b, N)).entries.map((e) => e.id).sort()).toEqual(["D0", "D1", "D2"]);
		expect(refAt(b, TRACKING)).toBe(refAt(b, LOCAL));
		expect(refAt(remote, LOCAL)).toBe(refAt(b, LOCAL));
		expect(await ledger.pending(N)).toBe(false);
	});

	it("the tracking ref never moves backwards after a push", async () => {
		const { remote, a, b } = await twoClones();
		const seed = createLedger(exec, a);
		await seed.append(N, decision("D0"));
		await seed.background();
		await createLedger(exec, b).ensureFetched(N);
		await appendEntry(exec, b, N, decision("D1"));
		// After B's push lands, A builds on it and B fetches the newer tip before B records its push.
		const execB = interceptOnce(
			(args) => args[0] === "update-ref" && args.includes(TRACKING),
			async () => {
				await createLedger(exec, a).ensureFetched(N);
				await appendEntry(exec, a, N, decision("D2"));
				expect(await createLedger(exec, a).sync(N)).toEqual({ status: "synced" });
				git(b, ["fetch", "-q", "origin", `+${LOCAL}:${TRACKING}`]);
			},
		);
		expect(await createLedger(execB, b).sync(N)).toEqual({ status: "synced" });
		expect(refAt(b, TRACKING)).toBe(refAt(remote, LOCAL));
		expect(await createLedger(exec, b).pending(N)).toBe(false);
	});

	it("remote ref deleted → tracking ref cleared", async () => {
		const { remote, a, b } = await twoClones();
		const ledger = createLedger(exec, a);
		await ledger.append(N, decision("D1"));
		await ledger.background();
		await createLedger(exec, b).ensureFetched(N);
		expect(refAt(b, TRACKING)).toBeDefined();
		git(remote, ["update-ref", "-d", LOCAL]);

		expect(await createLedger(exec, b).ensureFetched(N)).toBe("fetched");
		expect(refAt(b, TRACKING)).toBeUndefined();
		expect(refAt(remote, LOCAL)).toBeUndefined();
		expect(await createLedger(exec, b).sync(N)).toEqual({ status: "synced" });
		expect(refAt(remote, LOCAL)).toBe(refAt(b, LOCAL));
	});
});

describe("ledger fetched before use", () => {
	it("Second machine sees the first machine's records", async () => {
		const { a, b } = await twoClones();
		const ledgerA = createLedger(exec, a);
		const receipt = await ledgerA.append(N, { kind: "receipt", id: "receipt.U1", data: { unit: "U1" } });
		await ledgerA.background();

		const ledgerB = createLedger(exec, b);
		expect((await ledgerB.read(N)).entries).toEqual([]);
		expect(await ledgerB.ensureFetched(N)).toBe("fetched");
		expect((await ledgerB.read(N)).entries.map((e) => e.ref)).toEqual([receipt.ref]);
	});

	it("New change, empty remote", async () => {
		const { remote, a } = await twoClones();
		const ledger = createLedger(exec, a);
		expect(await ledger.ensureFetched(N)).toBe("fetched");
		await ledger.append(N, { kind: "unit-start", id: "start.U1", data: { unit: "U1" } });
		await ledger.background();
		expect(refAt(remote, LOCAL)).toBe(refAt(a, LOCAL));
	});

	it("Unknown ledger while offline", async () => {
		const { b } = await twoClones();
		offline(b);
		const ledger = createLedger(exec, b);
		expect(await ledger.ensureFetched(N)).toBe("unknown-offline");
		const attempt = ledger.append(N, decision("D1"));
		await expect(attempt).rejects.toBeInstanceOf(LedgerError);
		await expect(attempt).rejects.toMatchObject({ code: "unknown-offline" });
		expect(refAt(b, LOCAL)).toBeUndefined();
	});

	it("Known ledger while offline", async () => {
		const { a, b } = await twoClones();
		const ledgerA = createLedger(exec, a);
		await ledgerA.append(N, decision("D1"));
		await ledgerA.background();
		await createLedger(exec, b).ensureFetched(N);
		offline(b);

		const ledgerB = createLedger(exec, b);
		expect(await ledgerB.ensureFetched(N)).toBe("stale-known");
		const entry = await ledgerB.append(N, decision("D2"));
		await ledgerB.background();
		expect((await ledgerB.read(N)).entries.map((e) => e.ref)).toContain(entry.ref);
		expect(await ledgerB.pending(N)).toBe(true);
	});

	it("no origin remote counts as fetched", async () => {
		const { a } = await twoClones();
		git(a, ["remote", "remove", "origin"]);
		const ledger = createLedger(exec, a);
		expect(await ledger.ensureFetched(N)).toBe("fetched");
		await ledger.append(N, decision("D1"));
		await ledger.background();
		const result = await ledger.sync(N);
		expect(result.status).toBe("pending");
		expect(result.status === "pending" && result.reason).toMatch(/origin/);
	});
});

describe("ledger remove", () => {
	it("deletes the remote, local and tracking refs", async () => {
		const { remote, a } = await twoClones();
		const ledger = createLedger(exec, a);
		await ledger.append(N, decision("D1"));
		await ledger.background();
		expect(await ledger.remove(N)).toEqual({ remote: "deleted" });
		expect(refAt(remote, LOCAL)).toBeUndefined();
		expect(refAt(a, LOCAL)).toBeUndefined();
		expect(refAt(a, TRACKING)).toBeUndefined();
	});

	it("reports failed while offline and still deletes the local refs", async () => {
		const { remote, a } = await twoClones();
		const ledger = createLedger(exec, a);
		await ledger.append(N, decision("D1"));
		await ledger.background();
		offline(a);
		const result = await ledger.remove(N);
		expect(result.remote).toBe("failed");
		expect(result.message).toBeTruthy();
		expect(refAt(a, LOCAL)).toBeUndefined();
		expect(refAt(a, TRACKING)).toBeUndefined();
		expect(refAt(remote, LOCAL)).toBeDefined();
	});

	it("maps a remote moved after the sync to moved", async () => {
		const { remote, a, b } = await twoClones();
		const ledgerA = createLedger(exec, a);
		await ledgerA.append(N, decision("D1"));
		await ledgerA.background();
		await createLedger(exec, b).ensureFetched(N);
		await appendEntry(exec, b, N, decision("D2"));
		const execA = interceptOnce(
			(args) => args[0] === "push" && args.some((x) => x.startsWith("--force-with-lease")),
			async () => {
				expect(await createLedger(exec, b).sync(N)).toEqual({ status: "synced" });
			},
		);
		expect(await createLedger(execA, a).remove(N)).toEqual({ remote: "moved" });
		expect(refAt(remote, LOCAL)).toBe(refAt(b, LOCAL));
		expect(refAt(a, LOCAL)).toBeUndefined();
	});

	it("leases the delete on the synced tip, not a later local tip", async () => {
		const { remote, a } = await twoClones();
		const ledger = createLedger(exec, a);
		await ledger.append(N, decision("D1"));
		await ledger.background();
		// After the fetch, the sync reads the tracking ref and the local ref; the third ledger ref read
		// picks the lease tip. A local append lands right before it, after the sync has finished.
		let fetched = false;
		let refReads = 0;
		const execA: GitExec = async (args, opts) => {
			if (args[0] === "fetch") fetched = true;
			const readsLedgerRef = args[0] === "rev-parse" && args.some((x) => x.startsWith(LOCAL) || x.startsWith(TRACKING));
			if (fetched && readsLedgerRef && ++refReads === 3) await appendEntry(exec, a, N, decision("D2"));
			return defaultGitExec(args, opts);
		};
		expect(await createLedger(execA, a).remove(N)).toEqual({ remote: "deleted" });
		expect(refAt(remote, LOCAL)).toBeUndefined();
		expect(refAt(a, LOCAL)).toBeUndefined();
	});

	it("reports gone when no ledger exists anywhere", async () => {
		const { a } = await twoClones();
		expect(await createLedger(exec, a).remove(N)).toEqual({ remote: "gone" });
	});
});
