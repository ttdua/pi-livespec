import { afterEach, describe, expect, test } from "vitest";
import "../../src/initiatives/facts.ts";
import { parseChange } from "../../src/core/change.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { runChangeResume } from "../../src/tools/change-resume.ts";
import { asChild } from "../hooks/fake-pi.ts";
import { writeIn } from "../helpers/repo.ts";
import { cleanupDirs, textOf } from "./helpers.ts";
import { BRANCH, type ParkHarness, parkHarness, wip } from "./park-fixture.ts";
import { cardState } from "./unit-helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const labels = async (h: ParkHarness) => (await h.world.forge.getIssue(h.n)).labels;

/** Parks with U2's lane holding one commit (`src/u2.ts`) and U3's lane holding an uncommitted edit (`src/u3.ts`). */
async function parked(): Promise<ParkHarness> {
	const h = await parkHarness();
	await writeIn(h.lanes.U2.path, "src/u2.ts", "u2 partial\n");
	h.lanes.U2.git("add", "-A");
	h.lanes.U2.git("commit", "-q", "-m", "U2 partial");
	await writeIn(h.lanes.U3.path, "src/u3.ts", "u3 edit\n");
	const out = await h.park();
	expect(out.isError, textOf(out)).toBeFalsy();
	return h;
}

describe("change_resume", () => {
	test("Prerequisite not merged", async () => {
		const h = await parked();
		const head = h.git("rev-parse", "HEAD");
		const count = (await h.marked()).length;
		const out = await h.resume();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(`#${h.prereq}`);
		expect(h.git("rev-parse", "HEAD")).toBe(head);
		expect((await h.marked()).length).toBe(count);
		expect(await labels(h)).toContain("livespec:parked");
	});

	test("Resume with two lanes keeps all work", async () => {
		const h = await parked();
		const u2Wip = h.git("rev-parse", wip("U2"));
		await h.mergePrereq({ "other.txt": "o\n" });
		const tip = h.git("rev-parse", "origin/main");
		const out = await h.resume();
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(out.details).toEqual({ merged: [wip("U2"), wip("U3")] });
		for (const sha of [tip, u2Wip]) expect(h.git("merge-base", "--is-ancestor", sha, "HEAD")).toBe("");
		expect(h.git("show", "HEAD:src/u3.ts")).toBe("u3 edit");
		expect(h.git("show", "HEAD:src/u2.ts")).toBe("u2 partial");
		expect(await h.ofKind("regression")).toHaveLength(1);
		expect(await labels(h)).not.toContain("livespec:parked");
		const last = (await h.ofKind("parked")).at(-1)?.data as { resumed?: boolean };
		expect(last.resumed).toBe(true);
		expect(cardState(h).state.parkedCore).toBeUndefined();
		expect(parseChange(await h.world.bodyOf(h.n)).header.base).toBe(tip);
		// Remote wip branches are kept.
		expect(h.git("ls-remote", "origin", `refs/heads/${wip("U2")}`)).toContain(u2Wip);
	});

	test("Finished unit regresses", async () => {
		const h = await parked();
		await h.mergePrereq();
		const out = await h.resume();
		expect(out.isError, textOf(out)).toBeFalsy();
		expect((await h.units()).find((u) => u.id === "U1")?.done).toBe(false);
		expect(cardState(h).state.lock.staleUnits).toContain("U1");
		expect(cardState(h).step.next).toMatch(/Amend U1 with unit_amend/);
	});

	test("wip conflict aborts and rerun skips merged", async () => {
		const h = await parked();
		// The prerequisite changes src/u3.ts too, so U3's wip merge conflicts after the integration merge.
		await h.mergePrereq({ "other.txt": "o\n", "src/u3.ts": "prereq version\n" });
		const out = await h.resume();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(wip("U3"));
		expect(h.git("status", "--porcelain")).toBe("");
		expect(h.git("merge-base", "--is-ancestor", h.git("rev-parse", wip("U2")), "HEAD")).toBe("");
		expect(await labels(h)).toContain("livespec:parked");
		expect(cardState(h).state.parkedCore).toBeDefined();
		// Resolve by hand: merge U3's wip branch keeping its edit, then rerun.
		h.git("merge", "--no-ff", "--no-edit", "-X", "theirs", wip("U3"));
		const headBefore = h.git("rev-parse", "HEAD");
		const rerun = await h.resume();
		expect(rerun.isError, textOf(rerun)).toBeFalsy();
		expect(rerun.details).toEqual({ merged: [] });
		expect(h.git("rev-parse", "HEAD")).toBe(headBefore);
		expect(cardState(h).state.parkedCore).toBeUndefined();
	});

	test("dirty tree refuses", async () => {
		const h = await parked();
		await h.mergePrereq();
		await writeIn(h.root, "scratch.txt", "x\n");
		const out = await h.resume();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toMatch(/uncommitted|dirty/);
		expect(await labels(h)).toContain("livespec:parked");
	});

	test("not parked refuses", async () => {
		const h = await parkHarness();
		const out = await h.resume();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("not parked");
	});

	test("another issue number refuses", async () => {
		const h = await parked();
		await h.mergePrereq();
		const out = await h.resume(h.prereq);
		expect(out.isError).toBe(true);
		expect(await labels(h)).toContain("livespec:parked");
	});

	test("refused in a child session", async () => {
		const h = await parked();
		await h.mergePrereq();
		const out = await runChangeResume({ issue: h.n }, asChild(h.ctx) as never);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("child session");
		expect(await labels(h)).toContain("livespec:parked");
	});

	test("Resumed unit starts green", async () => {
		const h = await parked();
		await h.mergePrereq({ "other.txt": "o\n" });
		expect((await h.resume()).isError).toBeFalsy();
		// U2's partial work makes its Verify pass at HEAD.
		const out = await h.start("U2");
		expect(out.isError, textOf(out)).toBeFalsy();
		const record = (await h.ofKind("unit-start")).at(-1)?.data as { unit: string; pre: { verdict: string; exit: number } };
		expect(record).toMatchObject({ unit: "U2", pre: { verdict: "resumed", exit: 0 } });
		// A unit not listed by the park still must start red.
		expect(h.git("branch", "--show-current")).toBe(BRANCH);
	});
});
