import { existsSync, rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import "../../src/initiatives/facts.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { runChangePark } from "../../src/tools/change-park.ts";
import { asChild } from "../hooks/fake-pi.ts";
import { writeIn } from "../helpers/repo.ts";
import { cleanupDirs, originRefs, textOf } from "./helpers.ts";
import { BRANCH, type ParkHarness, parkHarness, wip } from "./park-fixture.ts";
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
