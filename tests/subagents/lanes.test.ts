// Tests of lane eligibility and naming (pure) and of the lane git operations in temporary repositories.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { createGit } from "../../src/engine/git.ts";
import type { ChangeState } from "../../src/engine/state-types.ts";
import { closeLane, excludeLanes, filesViolation, mergeLane, openLane } from "../../src/subagents/lane-ops.ts";
import { eligibleLanes, laneBranch, lanePath, laneRefusal } from "../../src/subagents/lanes.ts";
import { type LaneRecord, openLanes } from "../../src/subagents/state.ts";
import { parseMarked } from "../../src/forge/markers.ts";
import { stateFor } from "../helpers/change-state.ts";
import { commitAll, gitStatus, makeRepo, writeIn } from "../helpers/repo.ts";
import { changeBody, type UnitSpec } from "../tools/unit-helpers.ts";

const spec = (id: string, files: string[], depends: string[] = []): UnitSpec => ({ id, verify: "true", files, depends });

function lanesState(units: UnitSpec[], over: Partial<ChangeState["subagents"]> = {}, started: string[] = []): ChangeState {
	const body = `Base: ${"a".repeat(40)}\nBranch: livespec/per-ip-cap\n${changeBody(units)}`;
	const s = stateFor("build", { change: parseChange(body) });
	return {
		...s,
		evidence: { ...s.evidence, started: Object.fromEntries(started.map((id) => [id, { unit: id } as never])) },
		subagents: { ...s.subagents, executor: { ok: true, missing: [] }, ...over },
	};
}

const lane = (unit: string): LaneRecord => ({ unit, path: `/x/${unit}`, branch: `b-${unit}`, base: "s" });

describe("parallel-lanes eligibility", () => {
	test("overlapping files not parallel", () => {
		const s = lanesState([spec("U1", ["src/a.ts"]), spec("U2", ["src/api/x.ts"]), spec("U3", ["src/api/x.ts"])]);
		expect(eligibleLanes(s, 3)).toEqual(["U1", "U2"]);
		expect(laneRefusal({ ...s, subagents: { ...s.subagents, lanes: { U2: lane("U2") } } }, "U3", 3)).toContain("shares Files with U2");
	});

	test("a shared spec file is an overlap", () => {
		const s = lanesState([spec("U1", ["specs/a/spec.md", "src/a.ts"]), spec("U2", ["specs/a/spec.md", "src/b.ts"])]);
		expect(eligibleLanes(s, 3)).toEqual(["U1"]);
	});

	test("lane limit", () => {
		const five = ["U1", "U2", "U3", "U4", "U5"].map((id) => spec(id, [`src/${id}.ts`]));
		expect(eligibleLanes(lanesState(five), 3)).toEqual(["U1", "U2", "U3"]);
		const open = lanesState(five, { lanes: { U1: lane("U1") } });
		expect(eligibleLanes(open, 3)).toEqual(["U2", "U3"]);
	});

	test("depends, started units and no executor", () => {
		const units = [spec("U1", ["a"]), spec("U2", ["b"], ["U1"]), spec("U3", ["c"])];
		expect(eligibleLanes(lanesState(units), 3)).toEqual(["U1", "U3"]);
		expect(eligibleLanes(lanesState(units, {}, ["U1"]), 3)).toEqual(["U3"]);
		expect(eligibleLanes(lanesState(units, { executor: { ok: false, missing: ["spawn"] } }), 3)).toEqual([]);
		expect(laneRefusal(lanesState(units, { executor: { ok: false, missing: ["spawn"] } }), "U1", 3)).toContain("no capable subagent executor");
		expect(laneRefusal(lanesState(units), "U2", 3)).toContain("not a ready unit");
		expect(laneRefusal(lanesState(units, {}, ["U1"]), "U1", 3)).toContain("already started");
	});

	test("open refused over the limit (pure)", () => {
		const s = lanesState([spec("U2", ["a"]), spec("U3", ["b"])], { lanes: { U2: lane("U2") } });
		expect(laneRefusal(s, "U3", 1)).toContain("limit (lanes) is 1");
	});

	test("naming", () => {
		expect(lanePath("/r", "per-ip-cap", "U2")).toBe(join("/r", ".worktrees", "per-ip-cap--U2"));
		expect(laneBranch("per-ip-cap", "U2")).toBe("livespec/per-ip-cap--lane-U2");
	});
});

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

async function repo() {
	const root = await makeRepo();
	await writeIn(root, "src/a.ts", "a\n");
	commitAll(root);
	git(root, "switch", "-q", "-c", "livespec/per-ip-cap");
	const posted: string[] = [];
	const ops = { git: createGit(root), root, post: async (body: string) => void posted.push(body) };
	const records = () => openLanes(posted.map((b, i) => ({ ...(parseMarked(b) as { kind: string; id: string; data: unknown }), commentId: `${i}`, author: "me" })));
	return { root, ops, posted, records };
}

async function laneWith(r: Awaited<ReturnType<typeof repo>>, unit: string, files: Record<string, string>): Promise<LaneRecord> {
	const opened = await openLane(r.ops, "per-ip-cap", unit);
	if (!opened.ok) throw new Error(opened.message);
	for (const [p, t] of Object.entries(files)) await writeIn(opened.path, p, t);
	commitAll(opened.path, `work ${unit}`);
	return r.records()[unit] as LaneRecord;
}

describe("parallel-lanes worktrees", () => {
	test("lane created at path and branch", async () => {
		const r = await repo();
		const head = git(r.root, "rev-parse", "HEAD");
		const opened = await openLane(r.ops, "per-ip-cap", "U2");
		const path = join(r.root, ".worktrees", "per-ip-cap--U2");
		expect(opened).toEqual({ ok: true, path });
		expect(git(path, "branch", "--show-current")).toBe("livespec/per-ip-cap--lane-U2");
		expect(git(path, "rev-parse", "HEAD")).toBe(head);
		expect(r.records().U2).toEqual({ unit: "U2", path, branch: "livespec/per-ip-cap--lane-U2", base: head });
		expect(gitStatus(r.root)).toEqual([]);
	});

	test("the exclude entry is written once", async () => {
		const r = await repo();
		await excludeLanes(r.root);
		await excludeLanes(r.root);
		const text = readFileSync(join(r.root, ".git", "info", "exclude"), "utf8");
		expect(text.split("\n").filter((l) => l === "/.worktrees/")).toHaveLength(1);
	});

	test("lane reuses a clean leftover worktree and refuses a diverged one", async () => {
		const r = await repo();
		const first = await openLane(r.ops, "per-ip-cap", "U2");
		expect(first.ok).toBe(true);
		const again = await openLane(r.ops, "per-ip-cap", "U2");
		expect(again.ok).toBe(true);
		const path = join(r.root, ".worktrees", "per-ip-cap--U2");
		await writeIn(path, "src/u2.ts", "x\n");
		commitAll(path, "diverge");
		const before = r.posted.length;
		const refused = await openLane(r.ops, "per-ip-cap", "U2");
		expect(refused.ok).toBe(false);
		expect(refused.ok ? "" : refused.message).toContain(path);
		expect(r.posted).toHaveLength(before);
	});

	test("files violation is detected", async () => {
		const r = await repo();
		const l = await laneWith(r, "U2", { "src/u2.ts": "x\n", "src/other.ts": "y\n" });
		expect(await filesViolation(r.ops.git, l, ["src/u2.ts"])).toEqual(["src/other.ts"]);
	});

	test("a leftover on another branch or detached is refused with the branch found", async () => {
		const r = await repo();
		const path = join(r.root, ".worktrees", "per-ip-cap--U2");
		const head = git(r.root, "rev-parse", "HEAD");
		await r.ops.git.worktreeAddBranch(path, "wrong", head);
		const other = await openLane(r.ops, "per-ip-cap", "U2");
		expect(other.ok ? "" : other.message).toContain("wrong");
		await r.ops.git.worktreeRemove(path);
		await r.ops.git.worktreeAdd(path, head);
		const detached = await openLane(r.ops, "per-ip-cap", "U2");
		expect(detached.ok ? "" : detached.message).toContain("detached");
		expect(r.posted).toHaveLength(0);
	});

	test("the files-violation record is a system, non-advisory, out-of-scope finding", async () => {
		const r = await repo();
		const l = await laneWith(r, "U2", { "src/other.ts": "y\n" });
		await mergeLane(r.ops, l, { files: ["src/u2.ts"], round: 1, verify: async () => "green" });
		const summary = r.posted.map((b) => parseMarked(b)).find((m) => m?.kind === "finding-summary")?.data as { advisory: boolean; system?: string; findings: { scope: string }[] };
		expect(summary).toMatchObject({ advisory: false, system: "files-violation" });
		expect(summary.findings[0]?.scope).toBe("out-of-scope");
	});

	test("merged lane: merge commit with the lane head as second parent, lane removed", async () => {
		const r = await repo();
		const l = await laneWith(r, "U2", { "src/u2.ts": "x\n" });
		const laneHead = git(l.path, "rev-parse", "HEAD");
		const out = await mergeLane(r.ops, l, { files: ["src/u2.ts"], round: 1, verify: async () => "green" });
		expect(out).toBe("merged");
		expect(git(r.root, "rev-parse", "HEAD^2")).toBe(laneHead);
		expect(existsSync(l.path)).toBe(false);
		expect(git(r.root, "branch", "--list", l.branch)).toBe("");
		expect(r.records().U2).toBeUndefined();
		expect(parseMarked(r.posted.at(-1) as string)?.data).toMatchObject({ closed: true, outcome: "merged", head: laneHead });
	});

	test("merge conflict aborts and re-runs sequentially", async () => {
		const r = await repo();
		const l = await laneWith(r, "U2", { "src/a.ts": "lane\n" });
		await writeIn(r.root, "src/a.ts", "main\n");
		commitAll(r.root, "main edit");
		const head = git(r.root, "rev-parse", "HEAD");
		const out = await mergeLane(r.ops, l, { files: ["src/a.ts"], round: 1, verify: async () => "green" });
		expect(out).toBe("conflict");
		expect(git(r.root, "rev-parse", "HEAD")).toBe(head);
		expect(gitStatus(r.root)).toEqual([]);
		expect(existsSync(l.path)).toBe(false);
		expect(r.records().U2).toBeUndefined();
	});

	test("red after merge undoes the merge", async () => {
		const r = await repo();
		const l = await laneWith(r, "U3", { "src/u3.ts": "x\n" });
		const head = git(r.root, "rev-parse", "HEAD");
		const out = await mergeLane(r.ops, l, { files: ["src/u3.ts"], round: 1, verify: async () => "red" });
		expect(out).toBe("red");
		expect(git(r.root, "rev-parse", "HEAD")).toBe(head);
		expect(existsSync(l.path)).toBe(false);
		expect(parseMarked(r.posted.at(-1) as string)?.data).toMatchObject({ closed: true, outcome: "red" });
	});

	test("closeLane posts the closed record and removes the worktree and branch", async () => {
		const r = await repo();
		const l = await laneWith(r, "U2", { "src/u2.ts": "x\n" });
		await closeLane(r.ops, l, { outcome: "moved" });
		expect(existsSync(l.path)).toBe(false);
		expect(git(r.root, "branch", "--list", l.branch)).toBe("");
		expect(r.records().U2).toBeUndefined();
	});
});
