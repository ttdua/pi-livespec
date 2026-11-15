// Account resolution at session start, identity confirmation and the write
// block, through the hook harness: real git in a temp repo, the executable
// fake `gh` as the account registry, the memory forge as the adapter.

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ForgeError } from "../../src/forge/errors.ts";
import type { Forge } from "../../src/forge/types.ts";
import type { Session } from "../../src/hooks/session.ts";
import { getSession, setSession } from "../../src/hooks/session-store.ts";
import type { AccountRec } from "../forge/fake-gh/state.ts";
import {
	allDone,
	deferred,
	BUILD_LABELS,
	CHANGE_BRANCH,
	cleanupHomes,
	contextCall,
	harness,
	type HarnessOptions,
	ORIGIN_REMOTE,
	resumeBody,
	type ToolOut,
} from "./helpers.ts";

const TTDUA: AccountRec = { login: "ttdua", token: "tok-ttdua", push: true };
const NAICOI: AccountRec = { login: "naicoi92", token: "tok-naicoi", push: false };
const NAICOI_WRITER: AccountRec = { ...NAICOI, push: true };
const AUTO_NOTICE = "livespec uses `ttdua` for this repository (chosen automatically)";

const dirs: string[] = [];
afterEach(async () => {
	setSession(undefined);
	await cleanupHomes();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** The memory forge with `whoami` answering `login`, or rejecting with `error`. */
function whoamiAs(answer: string | Error, onFirstCall?: () => void): HarnessOptions["forge"] {
	return (world) => {
		let called = false;
		return new Proxy(world.forge, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				return async (...args: unknown[]) => {
					if (!called) {
						called = true;
						onFirstCall?.();
					}
					if (prop !== "whoami") return value.apply(target, args);
					if (answer instanceof Error) throw answer;
					return { login: answer };
				};
			},
		}) as Forge;
	};
}

function localGet(root: string, key: string): string | undefined {
	try {
		return execFileSync("git", ["config", "--local", "--get", key], { cwd: root, encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

function store(root: string, account: string, remote = ORIGIN_REMOTE): void {
	execFileSync("git", ["config", "--local", "livespec.account", account], { cwd: root });
	execFileSync("git", ["config", "--local", "livespec.accountRemote", remote], { cwd: root });
}

function current(): Session {
	const session = getSession();
	if (!session) throw new Error("no session");
	return session;
}

const text = (out: ToolOut) => out.content.map((c) => c.text).join("\n");
const notices = (h: { ctx: { ui: { notify: { mock: { calls: unknown[][] } } } } }) => h.ctx.ui.notify.mock.calls.map((c) => c[0] as string);

describe("account selection at session start", () => {
	test("First session", async () => {
		let storedAtFirstForgeCall: string | undefined;
		const h = await harness({
			branch: CHANGE_BRANCH,
			accounts: [NAICOI, TTDUA],
			forge: whoamiAs("ttdua", () => (storedAtFirstForgeCall = localGet(h.root, "livespec.account"))),
		});

		await h.start();

		expect(localGet(h.root, "livespec.account")).toBe("ttdua");
		expect(localGet(h.root, "livespec.accountRemote")).toBe(ORIGIN_REMOTE);
		expect(storedAtFirstForgeCall).toBe("ttdua");
		expect(notices(h).filter((m) => m.includes("livespec uses"))).toEqual([AUTO_NOTICE]);
		expect(current().accountNotice).toBe(AUTO_NOTICE);
		expect(current().account).toMatchObject({ source: "auto", account: "ttdua", user: "ttdua" });
		expect(h.detectCalls.at(-1)?.account).toEqual({ name: "ttdua", token: "tok-ttdua" });
	});

	test("Later session", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, accounts: [NAICOI, TTDUA], forge: whoamiAs("ttdua") });
		store(h.root, "ttdua");
		const before = await readFile(join(h.root, ".git", "config"), "utf8");

		await h.start();

		expect(await readFile(join(h.root, ".git", "config"), "utf8")).toBe(before);
		expect(notices(h).filter((m) => m.includes("livespec uses"))).toEqual([]);
		expect(current().accountNotice).toBeUndefined();
		expect(current().account).toMatchObject({ source: "stored", account: "ttdua" });
		expect(current().accountBlock).toBeUndefined();
	});

	test("Uninitialized project", async () => {
		const h = await harness({ initialized: false, accounts: [NAICOI, TTDUA] });
		const before = await readFile(join(h.root, ".git", "config"), "utf8");

		await h.start();

		expect(h.gh.read().argvLog).toEqual([]);
		expect(await readFile(join(h.root, ".git", "config"), "utf8")).toBe(before);
		expect(current().account).toBeUndefined();
	});

	test("Shared by worktrees", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, accounts: [NAICOI, TTDUA], forge: whoamiAs("ttdua") });
		await h.start();
		expect(current().account?.source).toBe("auto");
		const parent = await mkdtemp(join(tmpdir(), "ls-worktree-"));
		dirs.push(parent);
		const second = join(parent, "second");
		execFileSync("git", ["worktree", "add", "-q", "-b", "other", second], { cwd: h.root });
		const calls = h.gh.read().argvLog.length;

		await h.startIn(second);

		expect(current().cwd).toBe(second);
		expect(current().account).toMatchObject({ source: "stored", account: "ttdua" });
		expect(current().accountNotice).toBeUndefined();
		const later = h.gh.read().argvLog.slice(calls);
		expect(later.filter((argv) => argv[0] === "api")).toHaveLength(1);
		expect(later.some((argv) => argv.includes("naicoi92"))).toBe(false);
	});
});

describe("identity confirmation and the write block", () => {
	test("Confirmed candidate", async () => {
		const h = await harness({ accounts: [NAICOI, TTDUA], forge: whoamiAs("ttdua") });
		await h.start();

		expect(current().accountBlock).toBeUndefined();
		const out = await h.call("change_new", { name: "rate-limit" });
		expect(out.isError).toBe(false);
		expect(text(out)).toContain("Created change");
	});

	test("Mismatch blocks writes", async () => {
		const h = await harness({ accounts: [NAICOI, TTDUA], forge: whoamiAs("naicoi92") });
		await h.start();

		const out = await h.call("change_new", { name: "rate-limit" });
		expect(out.isError).toBe(true);
		expect(text(out)).toContain("ttdua");
		expect(text(out)).toContain("naicoi92");
		expect(await h.world.forge.searchIssues({ labels: [], state: "all" })).toEqual([]);
	});

	test("Refusal blocks writes", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, accounts: [NAICOI_WRITER, TTDUA], forge: whoamiAs("ttdua") });
		const n = await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody("x"), labels: BUILD_LABELS });
		await h.start();
		const block = current().accountBlock;
		expect(block).toContain("naicoi92");
		expect(block).toContain("ttdua");
		expect(block).toContain("/livespec account <name>");
		const before = (await h.world.forge.getIssue(n)).body;

		const write = await h.call("spec_write", { section: "Proposal", content: "Cap requests per IP." });
		expect(write.isError).toBe(true);
		expect(text(write)).toContain(block as string);
		expect((await h.world.forge.getIssue(n)).body).toBe(before);

		const status = await h.call("spec_status");
		expect(status.isError).toBe(false);
		expect(text(status)).toContain(`#${n}`);
	});

	test("Automatic advance blocked", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, accounts: [NAICOI_WRITER, TTDUA], forge: whoamiAs("ttdua") });
		const n = await h.world.seedIssue({ title: "per-ip-cap", body: allDone(resumeBody(h.head)), labels: BUILD_LABELS });

		await h.start();

		expect((await h.world.forge.getIssue(n)).labels).toEqual(BUILD_LABELS);
		expect(current().card.account?.blocked).toBe(current().accountBlock);
		expect(current().card.account?.blocked).toBeDefined();
	});

	test("Identity unconfirmed", async () => {
		const failure = new ForgeError({ code: "unreachable", operation: "whoami", message: "connection reset" });
		const h = await harness({ accounts: [TTDUA], forge: whoamiAs(failure) });
		await h.start();

		expect(current().accountBlock).toContain("connection reset");
		expect((await h.call("change_new", { name: "rate-limit" })).isError).toBe(true);
		// A successful read through the session's forge does not lift the block.
		await current().refresh();
		await current().forge?.searchIssues({ labels: [], state: "open" });
		expect((await h.call("spec_status")).content).toBeDefined();
		expect(current().forge?.isReadOnly()).toBe(false);
		expect(current().accountBlock).toBeDefined();
		expect((await h.call("change_new", { name: "rate-limit" })).isError).toBe(true);
	});

	test("Environment identity outside the registry", async () => {
		const h = await harness({ accounts: [TTDUA], accountEnv: { GH_TOKEN: "tok-bot" }, forge: whoamiAs("bot-account") });
		await h.start();

		expect(current().accountBlock).toBeUndefined();
		expect(current().account).toMatchObject({ source: "env", user: "bot-account" });
		expect((await h.call("change_new", { name: "rate-limit" })).isError).toBe(false);
		expect(localGet(h.root, "livespec.account")).toBeUndefined();
	});

	test("Invalid environment token", async () => {
		const rejected = new ForgeError({ code: "auth", operation: "whoami", status: 401, message: "Bad credentials" });
		const h = await harness({ accounts: [TTDUA], accountEnv: { GH_TOKEN: "tok-bad" }, forge: whoamiAs(rejected) });
		await h.start();

		expect(current().accountBlock).toContain("environment token");
		expect(current().accountBlock).toContain("GH_TOKEN");
		expect(current().accountBlock).toContain("rejected");
		expect((await h.call("change_new", { name: "rate-limit" })).isError).toBe(true);
	});

	test("session errors after resolution contain no token", async () => {
		const echo = new ForgeError({ code: "auth", operation: "whoami", status: 401, message: "bad credentials: tok-ttdua" });
		const h = await harness({ branch: CHANGE_BRANCH, accounts: [TTDUA], forge: whoamiAs(echo) });
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody("x"), labels: BUILD_LABELS });
		await h.start();
		const session = current();
		const out = await h.call("change_new", { name: "rate-limit" });

		expect(session.accountBlock).toContain("***");
		for (const value of [session.accountBlock, session.errors.join("\n"), JSON.stringify(session.card), text(out), JSON.stringify(out.details)]) {
			expect(value).not.toContain("tok-ttdua");
		}
	});

	test("account notice survives the resume render and is cleared after the first model card", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, accounts: [NAICOI, TTDUA], forge: whoamiAs("ttdua") });
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.start();
		const session = current();
		expect(h.pi.entries.filter((e) => e.customType === "livespec-resume")).toHaveLength(1);
		expect(session.accountNotice).toBe(AUTO_NOTICE);
		expect(session.card.account?.line).toBe(AUTO_NOTICE);

		await contextCall(h.pi, h.ctx, []);
		expect(session.accountNotice).toBeUndefined();
		expect(session.card.account?.line).toBeUndefined();

		await contextCall(h.pi, h.ctx, []);
		expect(session.card.account?.line).toBeUndefined();
	});

	test("the block stays on the card after the first model card", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, accounts: [NAICOI_WRITER, TTDUA] });
		await h.start();
		const session = current();
		const block = session.accountBlock;
		expect(block).toBeDefined();

		await contextCall(h.pi, h.ctx, []);
		await contextCall(h.pi, h.ctx, []);
		expect(session.card.account).toEqual({ blocked: block });
	});
});

describe("no write before the identity is confirmed", () => {
	test("a write while whoami is pending is refused, and allowed after confirmation", async () => {
		const who = deferred<void>();
		const h = await harness({
			accounts: [TTDUA],
			forge: (world) =>
				new Proxy(world.forge, {
					get(target, prop, receiver) {
						const value = Reflect.get(target, prop, receiver);
						if (prop !== "whoami") return typeof value === "function" ? value.bind(target) : value;
						return async () => {
							await who.promise;
							return { login: "ttdua" };
						};
					},
				}) as Forge,
		});
		const started = h.start();
		// Detection follows account resolution, which runs fake-`gh` subprocesses: allow for a loaded machine.
		await vi.waitFor(() => expect(h.detectCalls.length).toBe(1), { timeout: 10_000 });
		await new Promise((r) => setTimeout(r, 50));

		const during = await h.call("change_new", { name: "rate-limit" });
		expect(during.isError).toBe(true);
		expect(await h.world.forge.searchIssues({ labels: [], state: "all" })).toEqual([]);

		who.resolve();
		await started;
		const after = await h.call("change_new", { name: "rate-limit" });
		expect(after.isError).toBe(false);
	});
});

describe("asking once", () => {
	test("the question is asked through ctx.ui.select and the answer is stored", async () => {
		const h = await harness({
			branch: CHANGE_BRANCH,
			accounts: [NAICOI_WRITER, TTDUA],
			forge: whoamiAs("ttdua"),
			hasUI: true,
			select: async (_title, options) => options.find((o) => o.startsWith("ttdua ")),
		});
		await h.start();

		expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
		expect(localGet(h.root, "livespec.account")).toBe("ttdua");
		expect(current().account?.source).toBe("asked");
		expect(current().accountBlock).toBeUndefined();
	});
});

describe("switchAccount and reconnect", () => {
	test("switchAccount stores the account and reconnects with it", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, accounts: [NAICOI_WRITER, TTDUA], forge: whoamiAs("ttdua") });
		await h.start();
		const session = current();
		expect(session.accountBlock).toBeDefined();

		const r = await session.switchAccount("ttdua");

		expect(r.ok).toBe(true);
		expect(r.message).toContain("ttdua");
		expect(localGet(h.root, "livespec.account")).toBe("ttdua");
		expect(session.accountBlock).toBeUndefined();
		expect(session.account).toMatchObject({ account: "ttdua", source: "asked" });
		expect(h.detectCalls.at(-1)?.account).toEqual({ name: "ttdua", token: "tok-ttdua" });
		expect((await h.call("change_new", { name: "rate-limit" })).isError).toBe(false);
	});

	test("a refused switch keeps the current state", async () => {
		const h = await harness({ accounts: [NAICOI, TTDUA], forge: whoamiAs("ttdua") });
		await h.start();
		const session = current();

		const r = await session.switchAccount("naicoi92");

		expect(r.ok).toBe(false);
		expect(r.message).toContain("cannot push");
		expect(session.account?.account).toBe("ttdua");
		expect(session.accountBlock).toBeUndefined();
	});

	test("a switch whose reconnect fails is not reported as ok", async () => {
		let failDetect = false;
		const h = await harness({
			branch: CHANGE_BRANCH,
			accounts: [NAICOI_WRITER, TTDUA],
			forge: (world) => {
				if (failDetect) throw new ForgeError({ code: "unsupported", operation: "detectForge", message: "detection broke" });
				return world.forge;
			},
		});
		await h.start();
		failDetect = true;

		const r = await current().switchAccount("ttdua");

		expect(r.ok).toBe(false);
		expect(r.message).toContain("detection broke");
		expect(current().forge).toBeUndefined();
	});

	test("reconnect re-runs the resolution", async () => {
		const h = await harness({ accounts: [NAICOI, TTDUA], forge: whoamiAs("ttdua") });
		await h.start();
		const session = current();
		const detects = h.detectCalls.length;

		await session.reconnect();

		expect(h.detectCalls.length).toBe(detects + 1);
		expect(session.account).toMatchObject({ source: "stored", account: "ttdua" });
		expect(session.accountNotice).toBeUndefined();
	});
});
