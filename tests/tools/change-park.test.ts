import { existsSync, rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import "../../src/initiatives/facts.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { runChangePark } from "../../src/tools/change-park.ts";
import { asChild } from "../hooks/fake-pi.ts";
import { writeIn } from "../helpers/repo.ts";
import { cleanupDirs, originRefs, textOf } from "./helpers.ts";
import { openWorktreeLane } from "./lane-helpers.ts";
import { BRANCH, type ParkHarness, parkHarness, seedChoice, wip } from "./park-fixture.ts";
import { cardState } from "./unit-helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const WIP_REFS = /refs\/heads\/livespec\/per-ip-cap--wip-\w+/g;
const wipRefs = (h: ParkHarness): string[] => (originRefs(h.origin).match(WIP_REFS) ?? []).sort();
const labels = async (h: ParkHarness) => (await h.world.forge.getIssue(h.n)).labels;

/** U2's lane has one commit; U3's lane has uncommitted edits (one tracked, one untracked). */
async function withWork(h: ParkHarness): Promise<void> {
	await writeIn(h.lanes.U2.path, "src/u2.ts", "u2 partial\n");
	h.lanes.U2.git("add", "-A");
	h.lanes.U2.git("commit", "-q", "-m", "U2 partial");
	await writeIn(h.lanes.U3.path, "src/u3.ts", "u3 edit\n");
	await writeIn(h.lanes.U3.path, "README.md", "u3 readme\n");
}

describe("change_park", () => {
	test("Two lanes in progress", async () => {
		const h = await parkHarness();
		await withWork(h);
		const u2Head = h.lanes.U2.git("rev-parse", "HEAD");
		const out = await h.park();
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(wipRefs(h)).toEqual([`refs/heads/${wip("U2")}`, `refs/heads/${wip("U3")}`]);
		// U2's wip commit sits on the lane commit; U3's wip commit holds the edits.
		const u2Wip = h.git("rev-parse", `${wip("U2")}`);
		expect(h.git("rev-parse", `${u2Wip}^`)).toBe(u2Head);
		expect(h.git("show", `${wip("U3")}:src/u3.ts`)).toBe("u3 edit");
		expect(h.git("show", `${wip("U3")}:README.md`)).toBe("u3 readme");
		expect(h.git("log", "-1", "--format=%s", wip("U3"))).toBe(`wip(U3): parked for #${h.prereq}`);
		// Lanes closed as parked; worktrees and local lane branches are gone.
		const lanes = (await h.ofKind("lane")).filter((m) => (m.data as { closed?: boolean }).closed === true);
		expect(lanes.map((m) => [(m.data as { unit: string }).unit, (m.data as { outcome: string }).outcome]).sort()).toEqual([["U2", "parked"], ["U3", "parked"]]);
		expect(existsSync(h.lanes.U2.path) || existsSync(h.lanes.U3.path)).toBe(false);
		expect(h.git("branch", "--list", "*--lane-*")).toBe("");
		expect(h.git("branch", "--show-current")).toBe(BRANCH);
		expect(await labels(h)).toContain("livespec:parked");
		const all = await h.marked();
		expect(all.at(-1)?.kind).toBe("parked");
		const record = all.at(-1)?.data as { waits_for: number[]; units: { unit: string; branch?: string; head?: string; lane: boolean }[] };
		expect(record.waits_for).toEqual([h.prereq]);
		expect(record.units).toEqual([
			{ unit: "U2", branch: wip("U2"), head: u2Wip, lane: true },
			{ unit: "U3", branch: wip("U3"), head: h.git("rev-parse", wip("U3")), lane: true },
			{ unit: "U4", lane: false },
		]);
		expect(out.details).toEqual({ units: record.units });
		// Finished units keep their tick and receipt; the parked units are pending again.
		expect((await h.units()).find((u) => u.id === "U1")?.done).toBe(true);
		expect(cardState(h).state.evidence.started).toEqual({});
		expect(cardState(h).state.parkedCore?.units.map((u) => u.unit)).toEqual(["U2", "U3", "U4"]);
	});

	test("Unit with no work is not branched", async () => {
		const h = await parkHarness();
		const out = await h.park();
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(wipRefs(h)).toEqual([]);
		expect(h.git("branch", "--list", "*--wip-*")).toBe("");
		const record = (await h.ofKind("parked")).at(-1)?.data as { units: unknown[] };
		expect(record.units).toEqual([{ unit: "U2", lane: true }, { unit: "U3", lane: true }, { unit: "U4", lane: false }]);
	});

	test("work in the change worktree is branched and the worktree returns to the change branch", async () => {
		const h = await parkHarness();
		await writeIn(h.root, "src/u4.ts", "u4 edit\n");
		const before = h.git("rev-parse", "HEAD");
		const out = await h.park();
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(wipRefs(h)).toEqual([`refs/heads/${wip("U4")}`]);
		expect(h.git("show", `${wip("U4")}:src/u4.ts`)).toBe("u4 edit");
		expect(h.git("branch", "--show-current")).toBe(BRANCH);
		expect(h.git("rev-parse", "HEAD")).toBe(before);
		expect(h.git("status", "--porcelain")).toBe("");
	});

	test("Rerun after a failed push", async () => {
		const h = await parkHarness();
		await withWork(h);
		h.rejectPush("U3");
		const failed = await h.park();
		expect(failed.isError).toBe(true);
		expect(textOf(failed)).toContain(wip("U3"));
		expect(wipRefs(h)).toEqual([`refs/heads/${wip("U2")}`]);
		expect(await h.ofKind("parked")).toEqual([]);
		expect(await labels(h)).not.toContain("livespec:parked");
		const u2Wip = h.git("rev-parse", wip("U2"));
		h.allowPush();
		const out = await h.park();
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(wipRefs(h)).toEqual([`refs/heads/${wip("U2")}`, `refs/heads/${wip("U3")}`]);
		expect(h.git("rev-parse", wip("U2"))).toBe(u2Wip);
		expect(h.git("log", "--format=%s", wip("U2")).split("\n").filter((l) => l.startsWith("wip(U2)"))).toHaveLength(1);
		expect(await h.ofKind("parked")).toHaveLength(1);
		const closes = (await h.ofKind("lane")).filter((m) => (m.data as { closed?: boolean }).closed === true);
		expect(closes).toHaveLength(2);
	});

	test("missing lane worktree is listed without a branch", async () => {
		const h = await parkHarness();
		rmSync(h.lanes.U3.path, { recursive: true, force: true });
		const out = await h.park();
		expect(out.isError, textOf(out)).toBeFalsy();
		const record = (await h.ofKind("parked")).at(-1)?.data as { units: unknown[] };
		expect(record.units).toContainEqual({ unit: "U3", lane: true });
		expect(h.git("branch", "--list", "*--lane-U3")).toBe("");
	});

	test("a missing lane worktree with commits keeps them on a pushed wip branch", async () => {
		const h = await parkHarness();
		await writeIn(h.lanes.U3.path, "src/u3.ts", "u3 committed\n");
		h.lanes.U3.git("add", "-A");
		h.lanes.U3.git("commit", "-q", "-m", "U3 partial");
		const laneHead = h.lanes.U3.git("rev-parse", "HEAD");
		rmSync(h.lanes.U3.path, { recursive: true, force: true });
		const out = await h.park();
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(wipRefs(h)).toEqual([`refs/heads/${wip("U3")}`]);
		expect(h.git("ls-remote", "origin", `refs/heads/${wip("U3")}`)).toContain(laneHead);
		const record = (await h.ofKind("parked")).at(-1)?.data as { units: unknown[] };
		expect(record.units).toContainEqual({ unit: "U3", branch: wip("U3"), head: laneHead, lane: true });
		expect(h.git("branch", "--list", "*--lane-U3")).toBe("");
		const closed = (await h.ofKind("lane")).filter((m) => (m.data as { unit: string; closed?: boolean }).unit === "U3" && (m.data as { closed?: boolean }).closed === true);
		expect(closed).toHaveLength(1);
	});

	test("a lane branch with commits the wip branch lacks is kept", async () => {
		const h = await parkHarness();
		await writeIn(h.lanes.U3.path, "src/u3.ts", "u3 committed\n");
		h.lanes.U3.git("add", "-A");
		h.lanes.U3.git("commit", "-q", "-m", "U3 partial");
		rmSync(h.lanes.U3.path, { recursive: true, force: true });
		// A local wip branch from an interrupted park elsewhere (not merged into the change branch), without the lane commit.
		h.git("branch", wip("U3"), h.git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "other wip"));
		const out = await h.park();
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(textOf(out)).toContain("livespec/per-ip-cap--lane-U3");
		expect(h.git("branch", "--list", "*--lane-U3")).toContain("--lane-U3");
	});

	test("rerun after a crash between the lane close and the worktree removal", async () => {
		const h = await parkHarness();
		await writeIn(h.lanes.U2.path, "src/u2.ts", "u2 edit\n");
		// The crash: U2's closed record is posted; its worktree and lane branch are left behind and nothing else ran.
		const lane = cardState(h).state.subagents.lanes.U2;
		await h.seed("lane", "lane.U2", { ...lane, closed: true, outcome: "parked" });
		const out = await h.park();
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(h.git("show", `${wip("U2")}:src/u2.ts`)).toBe("u2 edit");
		expect(existsSync(h.lanes.U2.path)).toBe(false);
		expect(h.git("branch", "--list", "*--lane-U2")).toBe("");
		expect(await h.ofKind("parked")).toHaveLength(1);
		const record = (await h.ofKind("parked")).at(-1)?.data as { units: { unit: string }[] };
		expect(record.units.map((u) => u.unit)).toEqual(["U2", "U3", "U4"]);
	});

	test("a lane of a unit not in Units is branched before it closes", async () => {
		const h = await parkHarness();
		const ghost = await openWorktreeLane(h, "U9");
		await writeIn(ghost.path, "src/u9.ts", "u9\n");
		const out = await h.park();
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(h.git("show", `${wip("U9")}:src/u9.ts`)).toBe("u9");
		const record = (await h.ofKind("parked")).at(-1)?.data as { units: { unit: string }[] };
		expect(record.units.map((u) => u.unit)).toEqual(["U2", "U3", "U4", "U9"]);
		expect(existsSync(ghost.path)).toBe(false);
	});

	test("a second park after resume pushes the work done since the resume", async () => {
		const h = await parkHarness();
		await withWork(h);
		expect((await h.park()).isError).toBeFalsy();
		const firstU2 = h.git("rev-parse", wip("U2"));
		await h.mergePrereq({ "other.txt": "o\n" });
		const resumed = await h.resume();
		expect(resumed.isError, textOf(resumed)).toBeFalsy();
		// A second prerequisite is found and option A is chosen again.
		const second = await h.world.seedIssue({ title: "second", labels: ["livespec", "livespec:phase/shape"] });
		await h.world.editBodyBehindBack(h.n, (await h.world.bodyOf(h.n)).replace(`Depends: #${h.prereq}`, `Depends: #${h.prereq}, #${second}`));
		await h.session.refresh();
		const lanes = { U2: await openWorktreeLane(h, "U2"), U3: await openWorktreeLane(h, "U3") };
		for (const u of ["U2", "U3"]) expect((await h.start(u)).isError).toBeFalsy();
		await seedChoice(h, "A");
		await writeIn(lanes.U2.path, "src/u2.ts", "u2 after resume\n");
		lanes.U2.git("add", "-A");
		lanes.U2.git("commit", "-q", "-m", "U2 after resume");
		const u2New = lanes.U2.git("rev-parse", "HEAD");
		await writeIn(lanes.U3.path, "src/u3.ts", "u3 after resume\n");
		const out = await h.park();
		expect(out.isError, textOf(out)).toBeFalsy();
		const remote = (unit: string) => h.git("ls-remote", "origin", `refs/heads/${wip(unit)}`).split(/\s/)[0] as string;
		const record = (await h.ofKind("parked")).at(-1)?.data as { units: { unit: string; head?: string }[] };
		for (const unit of ["U2", "U3"]) expect(record.units.find((u) => u.unit === unit)?.head).toBe(remote(unit));
		expect(h.git("merge-base", "--is-ancestor", u2New, remote("U2"))).toBe("");
		expect(h.git("merge-base", "--is-ancestor", firstU2, remote("U2"))).toBe("");
		expect(h.git("show", `${remote("U2")}:src/u2.ts`)).toBe("u2 after resume");
		expect(h.git("show", `${remote("U3")}:src/u3.ts`)).toBe("u3 after resume");
	});

	test("a lane record with an invalid unit id is ignored and never pushed", async () => {
		const h = await parkHarness();
		// The marker id is a valid token; only the record's unit field carries the bad id.
		const lane = await openWorktreeLane(h, "U9");
		await h.seed("lane", "lane.U9", { unit: "U1;x", path: lane.path, branch: "livespec/per-ip-cap--lane-U9", base: h.head });
		await h.seed("lane", "lane.U9", { unit: "U9", path: lane.path, branch: "livespec/per-ip-cap--lane-U9", base: h.head, closed: true, outcome: "merged" });
		await writeIn(lane.path, "src/u9.ts", "x\n");
		const out = await h.park();
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(originRefs(h.origin)).not.toContain(";");
		const record = (await h.ofKind("parked")).at(-1)?.data as { units: { unit: string }[] };
		expect(record.units.map((u) => u.unit)).toEqual(["U2", "U3", "U4"]);
	});

	test("refused when nothing is left to wait for", async () => {
		const h = await parkHarness();
		await h.world.editBodyBehindBack(h.n, (await h.world.bodyOf(h.n)).replace(`Depends: #${h.prereq}`, "Depends: —"));
		await h.session.refresh();
		const before = originRefs(h.origin);
		const count = (await h.marked()).length;
		const out = await h.park();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("not in Depends yet or already merged");
		expect(originRefs(h.origin)).toBe(before);
		expect((await h.marked()).length).toBe(count);
		expect(await labels(h)).not.toContain("livespec:parked");
	});

	test("refused before choice A", async () => {
		for (const choice of [null, "B"] as const) {
			const h = await parkHarness({ choice });
			const before = originRefs(h.origin);
			const out = await h.park();
			expect(out.isError).toBe(true);
			expect(textOf(out)).toContain("new-dependency");
			expect(originRefs(h.origin)).toBe(before);
			expect(await h.ofKind("parked")).toEqual([]);
		}
	});

	test("refused once parked", async () => {
		const h = await parkHarness();
		expect((await h.park()).isError).toBeFalsy();
		const out = await h.park();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("parked");
		expect(await h.ofKind("parked")).toHaveLength(1);
	});

	test("refused in a child session", async () => {
		const h = await parkHarness();
		await withWork(h);
		const before = originRefs(h.origin);
		const out = await runChangePark(asChild(h.ctx) as never);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("child session");
		expect(originRefs(h.origin)).toBe(before);
		expect(await h.ofKind("parked")).toEqual([]);
	});
});

describe("Parked change refuses", () => {
	test("unit_start, unit_finish, change_start and change_split refuse and write nothing", async () => {
		const h = await parkHarness();
		expect((await h.park()).isError).toBeFalsy();
		const count = (await h.marked()).length;
		const issues = (await h.world.forge.searchIssues({ labels: ["livespec"], state: "open" })).length;
		for (const out of [await h.start("U3"), await h.finish("U4"), await h.call("change_split", { issue: h.n, units: ["U3"], into: "moved" })]) {
			expect(out.isError).toBe(true);
			expect(textOf(out)).toMatch(/parked/);
		}
		h.git("switch", "-q", "main");
		await h.session.refresh();
		const start = await h.call("change_start", { issue: h.n });
		expect(start.isError).toBe(true);
		expect(textOf(start)).toContain("parked");
		expect(h.git("branch", "--show-current")).toBe("main");
		expect((await h.marked()).length).toBe(count);
		expect((await h.world.forge.searchIssues({ labels: ["livespec"], state: "open" })).length).toBe(issues);
	});

	test("the refreshed card waits for the prerequisite and lists the wip branches", async () => {
		const h = await parkHarness();
		await writeIn(h.lanes.U2.path, "src/u2.ts", "u2\n");
		expect((await h.park()).isError).toBeFalsy();
		const { state, step } = cardState(h);
		expect(state.parked?.waitsFor).toEqual([{ number: h.prereq, title: "token-store", state: "open" }]);
		expect(step.next).toContain(`waiting for #${h.prereq}`);
		await h.mergePrereq();
		expect(cardState(h).step.next).toBe(`#${h.prereq} merged: a human runs change_resume #${h.n}.`);
	});
});
