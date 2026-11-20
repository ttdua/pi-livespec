// Shared setup for the `unit_start` / `unit_finish` tool tests: a locked build
// change whose units run small committed `sh` scripts, a run log outside the
// repo, a scripted forge wrapper and readers for the posted evidence.

import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { parseChange, type Unit } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import type { Forge, Issue, Version, WriteResult } from "../../src/forge/types.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import type { FakeUI } from "../hooks/fake-pi.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { type ToolHarness, type ToolHarnessOptions, toolHarness } from "./helpers.ts";

export type UnitSpec = { id: string; verify: string; files?: string[]; depends?: string[]; kind?: "refactor"; difficulty?: string };

const logDirs: string[] = [];

afterEach(() => {
	for (const dir of logDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function unitBlock(u: UnitSpec): string {
	return [
		`### ${u.id} — Unit ${u.id}`,
		"Covers: rate-limit/Requirement: Per-IP cap",
		`Difficulty: ${u.difficulty ?? "low"}`,
		"Tags: []",
		`Files: ${(u.files ?? [`src/${u.id.toLowerCase()}.ts`]).join(", ")}`,
		"Done means:",
		"- [a] works",
		"Scenarios:",
		`- [a] test/${u.id.toLowerCase()}.test.ts › works`,
		`Depends: ${u.depends && u.depends.length > 0 ? u.depends.join(", ") : "—"}`,
		`Verify: \`${u.verify}\``,
		...(u.kind ? [`Kind: ${u.kind}`] : []),
		"- [ ] pending",
	].join("\n");
}

/** The change body after the `Base:` and `Branch:` lines. */
export function changeBody(units: UnitSpec[]): string {
	return [
		"Depends: —",
		"Capabilities: new [], modified [rate-limit]",
		"Product impact: —",
		"",
		"## Proposal",
		"Limit each client IP.",
		"## Design",
		"Counter.",
		"## Questions",
		"",
		"## Units",
		...units.flatMap((u) => [unitBlock(u), ""]),
		"## Durable docs",
		"",
	].join("\n");
}

/** Every update the wrapped forge received, and what it answered. */
export type BodyWrites = { calls: number; written: number };
export type UpdateScript = (call: number) => "throw" | "conflict" | undefined;

/** Wraps a forge so `updateIssueBody` follows `script` (by 1-based call number) and is counted. */
export function scriptedForge(inner: Forge, writes: BodyWrites, script: UpdateScript = () => undefined): Forge {
	const updateIssueBody = async (n: number, body: string, expect: Version): Promise<WriteResult<Issue>> => {
		writes.calls++;
		const action = script(writes.calls);
		if (action === "throw") throw new Error("transport failed while writing the body");
		if (action === "conflict") return { status: "conflict", current: "cv:0" as Version, changed: ["body"] };
		const result = await inner.updateIssueBody(n, body, expect);
		if (result.status === "written") writes.written++;
		return result;
	};
	return new Proxy(inner, {
		get(target, prop) {
			if (prop === "updateIssueBody") return updateIssueBody;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export type UnitHarness = ToolHarness & {
	/** A file outside the repo that the scripts append one line to per run. */
	log: string;
	/** Whether this harness's `$SLEEP` command is running. */
	sleeping(): boolean;
	runs(): number;
	writes: BodyWrites;
	start(unit: string, signal?: AbortSignal): ReturnType<ToolHarness["call"]>;
	finish(unit: string, signal?: AbortSignal): ReturnType<ToolHarness["call"]>;
	/** Writes `files`, commits them and refreshes the session. */
	commit(files: Record<string, string>, message?: string): Promise<string>;
	marked(): Promise<MarkedComment[]>;
	ofKind(kind: string): Promise<MarkedComment[]>;
	units(): Promise<Unit[]>;
	/** Stores an own marked comment and refreshes. */
	seed(kind: string, id: string, data: unknown): Promise<void>;
};

export type UnitHarnessOptions = {
	units: UnitSpec[];
	/**
	 * Script files keyed by path; `$LOG` is replaced by the run log path, and `$SLEEP` by a long `sleep`
	 * whose argument is unique to this harness, so `sleeping()` never matches another process.
	 */
	scripts?: Record<string, string>;
	config?: string;
	update?: UpdateScript;
	/** Scripted dialogs of the tool ctx (for tools that ask a human, such as `spec_stuck`). */
	ui?: FakeUI;
};

export async function unitHarness(o: UnitHarnessOptions): Promise<UnitHarness> {
	const logDir = mkdtempSync(join(tmpdir(), "ls-unit-log-"));
	logDirs.push(logDir);
	const log = join(logDir, "runs.log");
	const sleep = `sleep 30.${randomInt(100_000_000, 999_999_999)}`;
	const files = Object.fromEntries(Object.entries(o.scripts ?? {}).map(([path, text]) => [path, text.replaceAll("$LOG", log).replaceAll("$SLEEP", sleep)]));
	const writes: BodyWrites = { calls: 0, written: 0 };
	const options: ToolHarnessOptions = {
		files,
		change: { body: changeBody(o.units) },
		locked: true,
		forge: (world) => scriptedForge(world.forge, writes, o.update),
		...(o.config !== undefined ? { config: o.config } : {}),
		...(o.ui !== undefined ? { ui: o.ui } : {}),
	};
	const h = await toolHarness(options);
	const marked = async () => filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
	return {
		...h,
		log,
		sleeping: () => running(sleep.replaceAll(".", "\\.")),
		writes,
		runs: () => {
			try {
				return readFileSync(log, "utf8").split("\n").filter(Boolean).length;
			} catch {
				return 0;
			}
		},
		start: (unit, signal) => h.call("unit_start", { unit }, signal),
		finish: (unit, signal) => h.call("unit_finish", { unit }, signal),
		commit: async (changes, message = "work") => {
			for (const [path, text] of Object.entries(changes)) await writeIn(h.root, path, text);
			commitAll(h.root, message);
			await h.session.refresh();
			return h.git("rev-parse", "HEAD");
		},
		marked,
		ofKind: async (kind) => (await marked()).filter((m) => m.kind === kind),
		units: async () => parseChange(await h.world.bodyOf(h.n)).units,
		seed: async (kind, id, data) => {
			await h.world.postComment(h.n, BOT_LOGIN, writeMarked(kind, id, data));
			await h.session.comments?.invalidate(h.n);
			await h.session.refresh();
		},
	};
}

/** The change state of the session's card; throws when the card shows no change. */
export function cardState(h: ToolHarness) {
	const card = h.session.card;
	if (card.kind !== "change") throw new Error(`card is ${card.kind}`);
	return { state: card.state, step: card.step };
}

/** Whether any process command line matches `pattern`; only pgrep's "no match" exit (1) means no. */
export function running(pattern: string): boolean {
	try {
		execFileSync("pgrep", ["-f", pattern]);
		return true;
	} catch (error) {
		if ((error as { status?: number }).status === 1) return false;
		throw error;
	}
}

export const verifyDirs = (): Set<string> => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("livespec-verify-")));

export function worktreeCount(h: ToolHarness): number {
	return h.git("worktree", "list").split("\n").filter(Boolean).length;
}

/** Polls `check` every 20 ms until it holds or `ms` pass. */
export async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
	const until = Date.now() + ms;
	while (!check()) {
		if (Date.now() > until) throw new Error("condition not reached in time");
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** Seeds a receipt for `unit` at its current digest, then a `rebuild` marker for round `round`, as the review route stage leaves them. */
export async function seedRebuild(h: UnitHarness, unit: string, round = 1): Promise<void> {
	const u = (await h.units()).find((x) => x.id === unit) as Unit;
	const sha = "a".repeat(40);
	await h.seed("receipt", `${unit}.old`, { unit, digest: unitDigest(u), verify: u.verify, pre: { sha, exit: 1 }, post: { sha, exit: 0 }, output: "", start: `${unit}.s` });
	await h.seed("rebuild", `rebuild.${unit}.${round}`, { unit, round, finding: "c1:0" });
}
