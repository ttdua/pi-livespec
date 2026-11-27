// Ledger fetched before use (ledger-store): tool refreshes run the first fetch of the session, the
// session-start card and the context hook read the local ref without waiting for the network.

import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { defaultGitExec, type GitExec } from "../../src/engine/git-exec.ts";
import { getSession, setSession } from "../../src/hooks/session-store.ts";
import { createLedger } from "../../src/ledger/index.ts";
import { BUILD_LABELS, CHANGE_BRANCH, cardText, cleanupHomes, deferred, harness, promptEvent, resumeBody } from "./helpers.ts";
import { cleanupDirs, toolHarness } from "../tools/helpers.ts";

afterEach(async () => {
	await cleanupDirs();
	await cleanupHomes();
	setSession(undefined);
});

const NETWORK = new Set(["ls-remote", "fetch", "push"]);
/** A ledger git call that talks to origin; local reads of `refs/livespec/*` are not. */
const isLedgerNetwork = (args: string[]): boolean => NETWORK.has(args[0] ?? "") && args.some((a) => a.includes("refs/livespec/"));
const ledgerFetches = (calls: string[][]): number => calls.filter((a) => a[0] === "ls-remote" && isLedgerNetwork(a)).length;

/** A clone of `origin` that appends a `decision` to change `n` and pushes it, as another machine would. */
async function appendFromOtherClone(origin: string, n: number): Promise<void> {
	const clone = join(await mkdtemp(join(tmpdir(), "ls-other-clone-")), "b");
	execFileSync("git", ["clone", "-q", origin, clone]);
	const other = createLedger(defaultGitExec, clone);
	await other.append(n, { kind: "decision", id: "tags.U1", data: { point: "tags", subject: "U1", source: "rule", outcome: [], reason: "r" } });
	expect(await other.sync(n)).toEqual({ status: "synced" });
	await other.background();
}

/** A tool harness on the change branch with the change issue seeded and no refresh run yet. */
async function unrefreshed() {
	const h = await toolHarness({ branch: CHANGE_BRANCH });
	const n = await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
	return { h, n };
}

describe("Ledger fetched before use", () => {
	test("the first tool refresh fetches and a second does not", async () => {
		const { h, n } = await unrefreshed();
		await appendFromOtherClone(h.origin, n);
		await h.call("spec_status");
		await h.call("spec_status");
		await h.settle();
		expect(ledgerFetches(h.gitCalls)).toBe(1);
		const card = getSession()?.card;
		expect(card?.kind === "change" ? card.state.marked.map((m) => [m.kind, m.source]) : card?.kind).toEqual([["decision", "ledger"]]);
	});

	test("subagent_packet on a fresh clone fetches first", async () => {
		const { h, n } = await unrefreshed();
		await appendFromOtherClone(h.origin, n);
		await h.call("subagent_packet", { role: "reviewer", subject: "change" });
		const card = getSession()?.card;
		expect(card?.kind === "change" ? card.state.marked.map((m) => m.id) : card?.kind).toEqual(["tags.U1"]);
	});

	test("session start and the context hook do not wait for the ledger", async () => {
		const hold = deferred<void>();
		const calls: string[][] = [];
		const holding = (real: GitExec): GitExec => (args, opts) => {
			calls.push(args);
			return isLedgerNetwork(args) ? hold.promise.then(() => real(args, opts)) : real(args, opts);
		};
		const h = await harness({ branch: CHANGE_BRANCH, sessionGit: holding });
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.start();
		await h.pi.fire("before_agent_start", promptEvent(), h.ctx);
		expect(await cardText(h.pi, h.ctx)).toContain("per-ip-cap");
		// Only the session-start sync has asked origin, and it is still held.
		expect(ledgerFetches(calls)).toBe(1);
		hold.resolve();
		await getSession()?.ledger.background();
	});
});

describe("prepareWrite", () => {
	test("Unknown ledger while offline", async () => {
		const { h, n } = await unrefreshed();
		h.git("remote", "set-url", "origin", join(tmpdir(), "ls-missing-origin", String(process.pid)));
		const before = (await h.world.forge.listComments(n)).length;
		const out = await h.call("skill_note", { phase: "build", skill: "debugging-and-error-recovery", reason: "r" });
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toContain(`the ledger of #${n} could not be fetched; reconnect and retry`);
		expect((await h.world.forge.listComments(n)).length).toBe(before);
	});
});
