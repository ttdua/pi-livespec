// Shared setup for hook tests: an initialized temp repo on a change branch, a
// memory forge, a fake content manager, a fake `AccountEnv` over the
// executable fake `gh` (one writable account by default, no ambient token, a
// temp `tea` config path) and the session hooks and tools over a fake pi.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountEnv } from "../../src/accounts/types.ts";
import type { ContentManager, UpgradeOutcome } from "../../src/content/manager.ts";
import { defaultGitExec, type GitExec } from "../../src/engine/git-exec.ts";
import { type DetectDeps, detectForge } from "../../src/forge/detect.ts";
import { ForgeError } from "../../src/forge/errors.ts";
import { defaultExec, type ExecFn } from "../../src/forge/github.ts";
import type { Forge } from "../../src/forge/types.ts";
import { registerContextHooks } from "../../src/hooks/context.ts";
import { registerSessionHooks, type SessionDeps } from "../../src/hooks/session.ts";
import { getSession } from "../../src/hooks/session-store.ts";
import { registerChangeTools } from "../../src/tools/change-tools.ts";
import { type AccountRec, FakeGhStore, emptyData } from "../forge/fake-gh/state.ts";
import { FAKE_GH_PATH } from "../forge/github-world.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { FIXTURE_BODY } from "../helpers/change-state.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";
import { FakePi, fakeCtx } from "./fake-pi.ts";

export const ORIGIN = "https://github.com/acme/shop.git";
/** `livespec.accountRemote` of ORIGIN. */
export const ORIGIN_REMOTE = "github.com/acme/shop";
/** The single writable account of the default harness; the memory forge's `whoami` answers its login. */
export const BOT_ACCOUNT: AccountRec = { login: BOT_LOGIN, token: "tok-livespec-bot", push: true };
export const CHANGE_BRANCH = "livespec/per-ip-cap";
export const BUILD_LABELS = ["livespec", "livespec:phase/build"];
export const TREE_SHA = "a".repeat(40);

/** Fixture body with Q1 answered and `Base:` set to `base`; U1 done, U3 pending. */
export function resumeBody(base: string): string {
	return FIXTURE_BODY.replace("- [ ] Q1 (blocking)", "- [x] Q1 (blocking)").replace(/^Base: .*$/m, `Base: ${base}`);
}

export const allDone = (body: string): string => body.replace("- [ ] pending", "- [x] done");

/** The origin URL is only parsed; git refuses http(s) in the repo, so nothing can reach the network. */
export function blockNetwork(root: string): void {
	execFileSync("git", ["config", "protocol.https.allow", "never"], { cwd: root });
	execFileSync("git", ["config", "protocol.http.allow", "never"], { cwd: root });
}

export type Deferred<T> = { promise: Promise<T>; resolve(v: T): void };

export function deferred<T>(): Deferred<T> {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

export type FakeContent = { manager: ContentManager; autoCheck: { calls: unknown[][]; outcome: Deferred<UpgradeOutcome> } };

/** A content manager whose `autoCheck` waits on a deferred outcome; `activeTree` is fixed. */
export function fakeContent(activeTree: string | undefined): FakeContent {
	const outcome = deferred<UpgradeOutcome>();
	const calls: unknown[][] = [];
	const manager = {
		activeTree: async () => activeTree,
		autoCheck: (...args: unknown[]) => {
			calls.push(args);
			return outcome.promise;
		},
	} as unknown as ContentManager;
	return { manager, autoCheck: { calls, outcome } };
}

/** A forge wrapper that throws `auth` on every call while `failing` is set (token expired mid-session). */
export function flakyForge(inner: Forge): { forge: Forge; fail(on: boolean): void } {
	let failing = false;
	const forge = new Proxy(inner, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (failing) throw new ForgeError({ code: "auth", operation: String(prop), message: "token expired" });
				return value.apply(target, args);
			};
		},
	});
	return { forge, fail: (on) => (failing = on) };
}

/**
 * Ambient token variables blanked for every fake run, so a real token of the
 * machine never decides identity; the fake `gh` treats an empty value as unset.
 */
const BLANK_TOKEN_ENV = { GH_TOKEN: "", GH_ENTERPRISE_TOKEN: "", GITEA_TOKEN: "" };

export type FakeAccounts = { env: AccountEnv; store: FakeGhStore };

/**
 * An `AccountEnv` over the executable fake `gh` holding `accounts` for `acme/shop`: `gh` runs the fake
 * with its state in `dir`, other programs (git) run for real with ambient tokens blanked. `env` is the
 * only environment the account flow sees; the `tea` config path is a temp path inside `dir`.
 */
export function fakeAccounts(dir: string, accounts: AccountRec[] = [BOT_ACCOUNT], env: Record<string, string> = {}): FakeAccounts {
	const store = new FakeGhStore(join(dir, "fake-gh-state.json"));
	store.init({ ...emptyData("acme/shop", accounts[0]?.login ?? BOT_LOGIN), accounts });
	const exec: ExecFn = (file, args, input, callEnv, signal) =>
		defaultExec(file === "gh" ? FAKE_GH_PATH : file, args, input, { ...BLANK_TOKEN_ENV, FAKE_GH_STATE: store.path, ...callEnv }, signal);
	return {
		store,
		env: {
			exec,
			git: (args, opts = {}) => defaultGitExec(args, { ...opts, env: { ...BLANK_TOKEN_ENV, ...opts.env } }),
			env: { ...env },
			fetch: async () => {
				throw new Error("hook tests make no HTTP call");
			},
			teaLookup: { env: {}, teaConfigPath: join(dir, "tea", "config.yml") },
			now: () => 0,
		},
	};
}

export type ToolOut = { content: { type: string; text: string }[]; details: unknown; isError?: boolean };

export type Harness = {
	root: string;
	home: string;
	head: string;
	world: MemoryWorld;
	pi: FakePi;
	ctx: ReturnType<typeof fakeCtx>;
	content: FakeContent;
	/** The fake `gh` state: accounts, argv and token env of every invocation. */
	gh: FakeGhStore;
	accounts: AccountEnv;
	/** The session's git runner, whose ledger calls reach a local bare origin; for tests that register the extension again. */
	gitExec: GitExec;
	/** The deps of every `detect` call, in order. */
	detectCalls: Partial<DetectDeps>[];
	/** Fires `session_start`, then waits for its background work (approval poll, cascade, feedback poll). */
	start(): Promise<unknown>;
	/** Fires `session_start` and returns once the hook does; the background work may still run. */
	startNoWait(): Promise<unknown>;
	/** Fires `session_start` with a ctx for another directory (a second worktree). */
	startIn(cwd: string): Promise<unknown>;
	/** Runs a registered livespec tool. */
	call(tool: string, params?: unknown): Promise<ToolOut>;
};

const homes: string[] = [];

/** Waits for the current session's background ledger syncs, then removes the temp homes. */
export async function cleanupHomes(): Promise<void> {
	await getSession()?.startInFlight;
	await getSession()?.ledger.background();
	for (const dir of homes.splice(0)) await rm(dir, { recursive: true, force: true });
}

/**
 * The session's git runner: ledger commands (any argument naming `refs/livespec/`) reach a local bare
 * repository through `url.<bare>.insteadOf`, so ledger fetches and syncs succeed while every other git
 * call still sees the unreachable forge-shaped origin.
 */
function ledgerOriginExec(bare: string, origin: string): GitExec {
	return (args, opts) => (args.some((a) => a.includes("refs/livespec/")) ? defaultGitExec(["-c", `url.${bare}.insteadOf=${origin}`, ...args], opts) : defaultGitExec(args, opts));
}

export type HarnessOptions = {
	initialized?: boolean;
	branch?: string;
	files?: Record<string, string>;
	forge?: (world: MemoryWorld) => Forge;
	detectFails?: boolean;
	activeTree?: string;
	/** Accounts of the fake `gh` registry; default one writable `BOT_ACCOUNT`. */
	accounts?: AccountRec[];
	/** The environment the account flow sees (e.g. `GH_TOKEN`); default empty. */
	accountEnv?: Record<string, string>;
	hasUI?: boolean;
	select?: (title: string, options: string[]) => Promise<string | undefined>;
	/**
	 * A real Gitea flow against the loopback fake at `url`: origin `<url>/acme/shop.git`, the project
	 * config names the Gitea, `tea` holds `teaConfig` (YAML) at the temp path, and the real
	 * `detectForge` builds the adapter over real `fetch`. `forge` is ignored.
	 */
	gitea?: { url: string; teaConfig: string };
	/** Wraps the account flow's git seam, e.g. to make a `git config --local --get` fail. */
	accountGit?: (real: GitExec) => GitExec;
	/** Wraps the session's git runner (git and ledger), e.g. to record or hold ledger fetches. */
	sessionGit?: (real: GitExec) => GitExec;
};

/** The project config of the harness: Gitea mode names the forge, so detection never probes. */
function projectConfig(o: HarnessOptions): string {
	const base = "integrationBranch: main\n";
	return o.gitea ? `${base}forge: gitea\ngiteaUrl: ${o.gitea.url}\n` : base;
}

/** The detect seam: the memory forge by default, the real detection in Gitea mode. */
function detectFor(o: HarnessOptions, world: MemoryWorld, calls: Partial<DetectDeps>[]): SessionDeps["detect"] {
	return async (root, detectDeps = {}) => {
		calls.push(detectDeps);
		if (o.detectFails) throw new ForgeError({ code: "unsupported", operation: "detectForge", message: "unknown forge host" });
		if (o.gitea) return detectForge(root, detectDeps);
		return o.forge ? o.forge(world) : world.forge;
	};
}

/** In Gitea mode the account flow talks HTTP to the fake and reads the written `tea` config. */
async function giteaAccounts(env: AccountEnv, gitea: HarnessOptions["gitea"]): Promise<AccountEnv> {
	if (!gitea) return env;
	const path = env.teaLookup.teaConfigPath as string;
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, gitea.teaConfig);
	return { ...env, fetch: globalThis.fetch };
}

/** A git repo with `origin`, optionally initialized and switched to `branch`, plus registered hooks. */
export async function harness(o: HarnessOptions = {}): Promise<Harness> {
	const root = await makeRepo();
	const home = await mkdtemp(join(tmpdir(), "ls-hooks-home-"));
	homes.push(home);
	await writeIn(root, "README.md", "x\n");
	if (o.initialized !== false) await writeIn(root, ".pi/livespec/config.yaml", projectConfig(o));
	for (const [rel, text] of Object.entries(o.files ?? {})) await writeIn(root, rel, text);
	commitAll(root);
	execFileSync("git", ["branch", "-M", "main"], { cwd: root });
	execFileSync("git", ["remote", "add", "origin", o.gitea ? `${o.gitea.url}/acme/shop.git` : ORIGIN], { cwd: root });
	blockNetwork(root);
	if (o.branch) execFileSync("git", ["switch", "-q", "-c", o.branch], { cwd: root });
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	const world = new MemoryWorld();
	const pi = new FakePi();
	const content = fakeContent(o.activeTree);
	const fake = fakeAccounts(home, o.accounts, o.accountEnv);
	const giteaEnv = await giteaAccounts(fake.env, o.gitea);
	const accounts = o.accountGit ? { ...giteaEnv, git: o.accountGit(giteaEnv.git) } : giteaEnv;
	const detectCalls: Partial<DetectDeps>[] = [];
	const ledgerOrigin = join(home, "ledger-origin.git");
	execFileSync("git", ["init", "-q", "--bare", ledgerOrigin]);
	const gitExec = (o.sessionGit ?? ((real) => real))(ledgerOriginExec(ledgerOrigin, o.gitea ? `${o.gitea.url}/acme/shop.git` : ORIGIN));
	const deps: Partial<SessionDeps> = {
		gitExec,
		home,
		accounts,
		detect: detectFor(o, world, detectCalls),
		content: () => content.manager,
		now: () => new Date("2026-11-15T08:00:00Z"),
	};
	registerSessionHooks(pi.api as never, deps);
	registerContextHooks(pi.api as never);
	registerChangeTools(pi.api as never);
	const ui = { hasUI: o.hasUI, select: o.select };
	const ctx = fakeCtx(root, true, ui);
	const startIn = (cwd: string) => pi.fire("session_start", { type: "session_start", reason: "startup" }, cwd === root ? ctx : fakeCtx(cwd, true, ui));
	const call = async (tool: string, params: unknown = {}) => {
		const t = pi.tools.get(tool);
		if (!t) throw new Error(`tool ${tool} is not registered`);
		return (await t.execute("call-1", params, undefined, undefined, ctx)) as ToolOut;
	};
	return { root, home, head, world, pi, ctx, content, gh: fake.store, accounts, gitExec, detectCalls, start: () => settledStart(startIn(root)), startNoWait: () => startIn(root), startIn: (cwd) => settledStart(startIn(cwd)), call };
}

/** Waits for the hook, then for the background work it started. */
async function settledStart(fired: Promise<unknown>): Promise<unknown> {
	const out = await fired;
	await getSession()?.startInFlight;
	return out;
}

export type PromptEvent = { type: "before_agent_start"; systemPromptOptions: { sections: Record<string, string> } };

export function promptEvent(): PromptEvent {
	return { type: "before_agent_start", systemPromptOptions: { sections: {} } };
}

export type Msg = { role: string; content: unknown; customType?: string; timestamp?: number };

export async function contextCall(pi: FakePi, ctx: unknown, messages: Msg[]): Promise<Msg[] | undefined> {
	const out = (await pi.fire("context", { type: "context", messages: structuredClone(messages) }, ctx)) as { messages: Msg[] } | undefined;
	return out?.messages;
}

/** The text of the last phase card that `context` appends to `messages`. */
export async function cardText(pi: FakePi, ctx: unknown, messages: Msg[] = []): Promise<string> {
	const out = await contextCall(pi, ctx, messages);
	const last = out?.at(-1);
	if (last?.customType !== "livespec-phase-card") throw new Error("no phase card appended");
	return last.content as string;
}
