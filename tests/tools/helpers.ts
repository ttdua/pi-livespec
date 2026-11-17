// Shared setup for tool tests: a temp repo with a local bare `origin`, an
// initialized livespec project, a memory forge behind CachedForge, and a
// Session built directly (session_start needs a parseable remote URL, which a
// local bare origin is not). Tools and context hooks register on a fake pi.

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { CommentsCache } from "../../src/engine/comments-cache.ts";
import { defaultGitExec, type GitExec } from "../../src/engine/git-exec.ts";
import { createGit } from "../../src/engine/git.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import { CachedForge } from "../../src/forge/cache.ts";
import type { Forge } from "../../src/forge/types.ts";
import { registerContextHooks } from "../../src/hooks/context.ts";
import { Session } from "../../src/hooks/session.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { registerChangeTools } from "../../src/tools/change-tools.ts";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { writeMarked } from "../../src/forge/markers.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { FakePi, type FakeUI, fakeCtx } from "../hooks/fake-pi.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";

export type ToolOut = { content: { type: string; text: string }[]; details: unknown; isError?: boolean };

export type ToolHarness = {
	root: string;
	origin: string;
	head: string;
	world: MemoryWorld;
	forge: CachedForge;
	session: Session;
	pi: FakePi;
	ctx: ReturnType<typeof fakeCtx>;
	/** Runs a registered tool; `signal` is the tool call's abort signal. */
	call(tool: string, params?: unknown, signal?: AbortSignal): Promise<ToolOut>;
	git(...args: string[]): string;
	/** Every git command the session ran, in order (args only). */
	gitCalls: string[][];
	/** The change issue seeded from `change`, if any. */
	n: number;
};

export type ToolHarnessOptions = {
	config?: string;
	files?: Record<string, string>;
	branch?: string;
	forge?: (world: MemoryWorld) => Forge;
	/** Runs after the first commit and before the session is built (e.g. to add a `develop` branch). */
	prepare?: (git: (...args: string[]) => string) => void;
	/** Scripted dialogs of the tool `ctx`; without it the ctx has no UI. */
	ui?: FakeUI;
	/** Seeds an open change issue on `livespec/per-ip-cap` (or `branch`): `Base:` and `Branch:` lines, then `body`. */
	change?: { body: string; phase?: string };
	/** With `change`: posts an approved plan `gate` comment locking every unit at its current digest. */
	locked?: boolean;
};

const CHANGE_BRANCH = "livespec/per-ip-cap";
const LOCKED_AT = "2026-11-15T10:00:00.000Z";

/** Seeds the change issue of `o.change` and, with `o.locked`, the approved plan gate that locks its units. */
async function seedChange(world: MemoryWorld, o: ToolHarnessOptions, head: string, branch: string): Promise<number> {
	if (!o.change) return 0;
	const body = `Base: ${head}\nBranch: ${branch}\n${o.change.body}`;
	const n = await world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", `livespec:phase/${o.change.phase ?? "build"}`] });
	if (o.locked) {
		const locked = Object.fromEntries(parseChange(body).units.map((u) => [u.id, unitDigest(u)]));
		const data = { phase: "plan", outcome: "approved", notes: "", by: "alice", at: LOCKED_AT, adapter: "in-session", head_sha: head, waivers: [], locked };
		await world.postComment(n, BOT_LOGIN, writeMarked("gate", "plan.self-1", data));
	}
	return n;
}

const dirs: string[] = [];

export async function cleanupDirs(): Promise<void> {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}

function gitIn(cwd: string): (...args: string[]) => string {
	return (...args) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

export async function toolHarness(o: ToolHarnessOptions = {}): Promise<ToolHarness> {
	const root = await makeRepo();
	const scratch = await mkdtemp(join(tmpdir(), "ls-tools-"));
	dirs.push(scratch);
	const origin = join(scratch, "origin.git");
	const home = join(scratch, "home");
	const git = gitIn(root);
	await writeIn(root, "README.md", "x\n");
	await writeIn(root, ".pi/livespec/config.yaml", o.config ?? "integrationBranch: main\n");
	for (const [rel, text] of Object.entries(o.files ?? {})) await writeIn(root, rel, text);
	commitAll(root);
	git("branch", "-M", "main");
	execFileSync("git", ["init", "-q", "--bare", origin]);
	git("remote", "add", "origin", origin);
	git("push", "-q", "origin", "main");
	o.prepare?.(git);
	const branch = o.branch ?? (o.change ? CHANGE_BRANCH : undefined);
	if (branch) git("switch", "-q", "-c", branch);
	const head = git("rev-parse", "HEAD");
	const world = new MemoryWorld();
	const n = await seedChange(world, o, head, branch ?? "main");
	const cacheRoot = join(home, "cache");
	const forge = new CachedForge(o.forge ? o.forge(world) : world.forge, { cacheRoot, host: "git.example.test", owner: "acme", repo: "shop" });
	const gitCalls: string[][] = [];
	const recording: GitExec = (args, opts) => {
		gitCalls.push(args);
		return defaultGitExec(args, opts);
	};
	const session = new Session(root, createGit(root, recording));
	session.config = await loadConfig(root, home);
	session.pack = await loadPack(root);
	session.forge = forge;
	session.comments = new CommentsCache({ dir: join(cacheRoot, "git.example.test", "acme", "shop") });
	setSession(session);
	if (o.change) await session.refresh();
	const pi = new FakePi();
	registerChangeTools(pi.api as never);
	registerContextHooks(pi.api as never);
	const ctx = fakeCtx(root, true, o.ui);
	const call = async (tool: string, params: unknown = {}, signal?: AbortSignal) => {
		const t = pi.tools.get(tool);
		if (!t) throw new Error(`tool ${tool} is not registered`);
		return (await t.execute("call-1", params, signal, undefined, ctx)) as ToolOut;
	};
	return { root, origin, head, world, forge, session, pi, ctx, call, git, gitCalls, n };
}

export const textOf = (out: ToolOut): string => out.content.map((c) => c.text).join("\n");

/** Every ref of the bare origin with its sha, for "no push" assertions. */
export function originRefs(origin: string): string {
	return execFileSync("git", ["for-each-ref", "--format=%(objectname) %(refname)"], { cwd: origin, encoding: "utf8" });
}
