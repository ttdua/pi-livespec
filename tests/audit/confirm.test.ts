// drift-audit "Scout confirmation" and the audit exceptions of subagent-dispatch.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type ConfirmDeps, confirmItems } from "../../src/audit/confirm.ts";
import { type DriftItem, driftItem } from "../../src/audit/items.ts";
import { createGit } from "../../src/engine/git.ts";
import { excludedPackages } from "../../src/subagents/isolation.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";
import { applied, fakeExecutor } from "../subagents/fake-executor.ts";

const UNTESTED = driftItem("scenario-untested", "rate-limit/rejects 101st request", 'specs/rate-limit/spec.md:20 scenario "rejects 101st request" is named in no test file', "rate-limit");
const REMOVED = driftItem("removed-reference", "rate-limit/src/limit/old.ts", "specs/rate-limit/spec.md:18 cites `src/limit/old.ts`, which is not in the tree", "rate-limit");
const TERM = driftItem("unused-term", "Bucket", "specs/glossary.md defines Bucket, used nowhere else");
const ITEMS: DriftItem[] = [UNTESTED, REMOVED, TERM];

const scoutResult = (verdicts: { key: string; verdict: "confirmed" | "refuted"; reason: string }[]) => ({
	structuredResult: { status: "DONE", notes: "judged", discoveries: [], sources_used: [], verdicts },
});

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repository whose `main` lacks the test the feature branch adds; returns the audited (main) commit. */
async function repo(): Promise<{ root: string; audited: string }> {
	const root = await makeRepo();
	await writeIn(root, "specs/rate-limit/spec.md", "# rate-limit\n");
	commitAll(root);
	git(root, "branch", "-M", "main");
	const audited = git(root, "rev-parse", "HEAD");
	git(root, "switch", "-q", "-c", "livespec/x");
	await writeIn(root, "tests/limit.test.ts", 'it("rejects 101st request", () => {});\n');
	commitAll(root, "feature test");
	return { root, audited };
}

function deps(root: string, f: ReturnType<typeof fakeExecutor> | undefined, exclusions: string[] = []): ConfirmDeps {
	return { ...(f === undefined ? {} : { service: f.service }), events: f?.events ?? { on: () => () => undefined }, git: createGit(root), root, exclusions };
}

describe("confirmItems", () => {
	test("Renamed test refuted", async () => {
		const { root, audited } = await repo();
		const f = fakeExecutor({
			records: [scoutResult([
				{ key: UNTESTED.key, verdict: "refuted", reason: "tested as `rejects the 101st request`" },
				{ key: REMOVED.key, verdict: "confirmed", reason: "no such file" },
			])],
		});
		const out = await confirmItems(ITEMS, audited, deps(root, f));
		expect(out.refuted).toEqual([{ key: UNTESTED.key, reason: "tested as `rejects the 101st request`" }]);
		expect(out.kept.map((i) => i.key)).toEqual([REMOVED.key, TERM.key]);
		expect(out.kept.find((i) => i.key === REMOVED.key)?.confirmed).toBe(true);
		expect(out.kept.find((i) => i.key === TERM.key)?.confirmed).toBeUndefined();
	});

	test("No executor", async () => {
		const { root, audited } = await repo();
		const out = await confirmItems(ITEMS, audited, deps(root, undefined));
		expect(out.refuted).toEqual([]);
		expect(out.kept.find((i) => i.key === UNTESTED.key)?.confirmed).toBe(false);
		expect(out.kept.find((i) => i.key === REMOVED.key)?.confirmed).toBe(false);
		expect(out.kept.find((i) => i.key === TERM.key)).toEqual(TERM);
		expect(out.note).toMatch(/no capable executor/);
		expect(out.note).not.toContain("subagent_packet");
	});

	test("Launch mismatch", async () => {
		const world = new MemoryWorld();
		const issue = await world.seedIssue({ title: "initiative" });
		const { root, audited } = await repo();
		const f = fakeExecutor({ facts: (o) => ({ ...applied(o), cwd: "/elsewhere" }), records: [scoutResult([])] });
		const out = await confirmItems(ITEMS, audited, deps(root, f));
		expect(f.aborted).toEqual(["agent-1"]);
		expect(out.kept.filter((i) => i.confirmed === false).map((i) => i.key)).toEqual([UNTESTED.key, REMOVED.key]);
		expect(out.note).toMatch(/unconfirmed/);
		expect(out.note).not.toMatch(/inline/);
		expect(await world.forge.listComments(issue)).toEqual([]);
	});

	test("Scout sees the audited snapshot", async () => {
		const { root, audited } = await repo();
		const seen: { head: string; hasTest: boolean }[] = [];
		const f = fakeExecutor({
			facts: (o) => {
				seen.push({ head: git(o.cwd, "rev-parse", "HEAD"), hasTest: existsSync(join(o.cwd, "tests/limit.test.ts")) });
				return applied(o);
			},
			records: [scoutResult([])],
		});
		await confirmItems(ITEMS, audited, deps(root, f));
		expect(f.spawned[0]?.options.cwd).not.toBe(root);
		expect(seen).toEqual([{ head: audited, hasTest: false }]);
		expect(existsSync(f.spawned[0]?.options.cwd as string)).toBe(false);
		expect(f.spawned[0]?.prompt).toContain(`Audited commit: ${audited}`);
		expect(f.spawned[0]?.prompt).toContain(`<untrusted>${UNTESTED.key}`);
		expect(f.spawned[0]?.prompt).not.toContain(TERM.key);
	});

	test("Audit scout launch", async () => {
		const { root, audited } = await repo();
		const exclusions = excludedPackages(["git:github.com/obra/superpowers"], ["npm:user-extra"]);
		const f = fakeExecutor({ records: [scoutResult([])] });
		await confirmItems(ITEMS, audited, deps(root, f, exclusions));
		const o = f.spawned[0]?.options;
		expect(f.spawned).toHaveLength(1);
		expect(f.spawned[0]?.type).toBe("scout");
		expect(o?.metadata.change).toBe("audit");
		expect(o?.metadata.role).toBe("scout");
		expect(o?.thinkingLevel).toBe("low");
		expect(o).not.toHaveProperty("model");
		expect(o?.context).toBe("fresh");
		expect(o?.skills).toEqual({ inherit: false, paths: [] });
		expect(o?.excludeExtensionPackages).toEqual(expect.arrayContaining(["git:github.com/obra/superpowers", "npm:user-extra"]));
	});

	test("Audit scout writes no dispatch record", async () => {
		const world = new MemoryWorld();
		const issue = await world.seedIssue({ title: "initiative" });
		const { root, audited } = await repo();
		const f = fakeExecutor({ records: [scoutResult([{ key: UNTESTED.key, verdict: "confirmed", reason: "real" }])] });
		const out = await confirmItems(ITEMS, audited, deps(root, f));
		expect(out.kept.find((i) => i.key === UNTESTED.key)?.confirmed).toBe(true);
		expect(out.kept.find((i) => i.key === REMOVED.key)?.confirmed).toBe(false);
		expect(await world.forge.listComments(issue)).toEqual([]);
	});

	test("a worktree that cannot be created leaves the items unconfirmed", async () => {
		const { root } = await repo();
		const f = fakeExecutor({ records: [scoutResult([])] });
		const out = await confirmItems(ITEMS, "f".repeat(40), deps(root, f));
		expect(f.spawned).toEqual([]);
		expect(out.kept.filter((i) => i.confirmed === false)).toHaveLength(2);
		expect(out.note).toMatch(/worktree/);
	});

	test("no heuristic item launches nothing", async () => {
		const { root, audited } = await repo();
		const f = fakeExecutor();
		const out = await confirmItems([TERM], audited, deps(root, f));
		expect(f.spawned).toEqual([]);
		expect(out).toEqual({ kept: [TERM], refuted: [] });
	});
});
