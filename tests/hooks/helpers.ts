// Shared setup for hook tests: an initialized temp repo on a change branch, a
// memory forge, a fake content manager and the session hooks over a fake pi.

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentManager, UpgradeOutcome } from "../../src/content/manager.ts";
import { ForgeError } from "../../src/forge/errors.ts";
import type { Forge } from "../../src/forge/types.ts";
import { registerContextHooks } from "../../src/hooks/context.ts";
import { registerSessionHooks, type SessionDeps } from "../../src/hooks/session.ts";
import { FIXTURE_BODY } from "../helpers/change-state.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";
import { FakePi, fakeCtx } from "./fake-pi.ts";

export const ORIGIN = "https://git.example.test/acme/shop.git";
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

export type Harness = {
	root: string;
	home: string;
	head: string;
	world: MemoryWorld;
	pi: FakePi;
	ctx: ReturnType<typeof fakeCtx>;
	content: FakeContent;
	start(): Promise<unknown>;
};

const homes: string[] = [];

export async function cleanupHomes(): Promise<void> {
	for (const dir of homes.splice(0)) await rm(dir, { recursive: true, force: true });
}

export type HarnessOptions = {
	initialized?: boolean;
	branch?: string;
	files?: Record<string, string>;
	forge?: (world: MemoryWorld) => Forge;
	detectFails?: boolean;
	activeTree?: string;
};

/** A git repo with `origin`, optionally initialized and switched to `branch`, plus registered hooks. */
export async function harness(o: HarnessOptions = {}): Promise<Harness> {
	const root = await makeRepo();
	const home = await mkdtemp(join(tmpdir(), "ls-hooks-home-"));
	homes.push(home);
	await writeIn(root, "README.md", "x\n");
	if (o.initialized !== false) await writeIn(root, ".pi/livespec/config.yaml", "integrationBranch: main\n");
	for (const [rel, text] of Object.entries(o.files ?? {})) await writeIn(root, rel, text);
	commitAll(root);
	execFileSync("git", ["branch", "-M", "main"], { cwd: root });
	execFileSync("git", ["remote", "add", "origin", ORIGIN], { cwd: root });
	blockNetwork(root);
	if (o.branch) execFileSync("git", ["switch", "-q", "-c", o.branch], { cwd: root });
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	const world = new MemoryWorld();
	const pi = new FakePi();
	const content = fakeContent(o.activeTree);
	const deps: Partial<SessionDeps> = {
		home,
		detect: async () => {
			if (o.detectFails) throw new ForgeError({ code: "unsupported", operation: "detectForge", message: "unknown forge host" });
			return o.forge ? o.forge(world) : world.forge;
		},
		content: () => content.manager,
		now: () => new Date("2026-11-15T08:00:00Z"),
	};
	registerSessionHooks(pi.api as never, deps);
	registerContextHooks(pi.api as never);
	const ctx = fakeCtx(root);
	return { root, home, head, world, pi, ctx, content, start: () => pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx) };
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
