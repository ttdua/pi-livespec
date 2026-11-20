// Tests of `lane_open` and `lane_merge` through the registered tools, in temporary git repositories with a fake executor.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { unitDigest } from "../../src/core/digest.ts";
import { gatePayload } from "../../src/engine/gate-payload.ts";
import { createGit } from "../../src/engine/git.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { asChild } from "../hooks/fake-pi.ts";
import { commitAll, gitStatus, writeIn } from "../helpers/repo.ts";
import { DEFAULT_SKILLS, makeTree } from "../subagents/packet-world.ts";
import { fakeExecutor, publish, unpublish } from "../subagents/fake-executor.ts";
import { seedSummary } from "./finding-helpers.ts";
import { cleanupDirs, textOf, type ToolOut } from "./helpers.ts";
import { cardState, type UnitHarness, type UnitSpec, unitHarness } from "./unit-helpers.ts";

afterEach(async () => {
	unpublish();
	setSession(undefined);
	await cleanupDirs();
});

const SPEC = readFileSync(new URL("../fixtures/rate-limit.spec.md", import.meta.url), "utf8");
const check = (file: string, extra = "") => `test -f ${file}${extra}\n`;
const SCRIPTS = {
	"specs/rate-limit/spec.md": SPEC,
	"check1.sh": check("src/u1.ts"),
	"check2.sh": check("src/u2.ts"),
	"check3.sh": check("src/u3.ts", " && ! test -f src/broken.flag"),
};
const unit = (id: string, difficulty = "low"): UnitSpec => ({ id, verify: `sh check${id.slice(1)}.sh`, difficulty });

type LaneHarness = UnitHarness & { fake: ReturnType<typeof fakeExecutor>; open(u: string): Promise<ToolOut>; merge(u: string): Promise<ToolOut>; lanePath(u: string): string };

/** U1..U3, an executor present, the content tree for packets and `lanes` from the user config. */
async function laneHarness(o: { difficulty?: string; lanes?: number; facts?: Parameters<typeof fakeExecutor>[0] } = {}): Promise<LaneHarness> {
	const h = await unitHarness({ units: ["U1", "U2", "U3"].map((id) => unit(id, o.difficulty)), scripts: SCRIPTS });
	h.session.activeTree = makeTree([...DEFAULT_SKILLS]);
	h.session.config.user.lanes = o.lanes ?? 3;
	const fake = fakeExecutor(o.facts);
	publish(fake.service);
	Object.assign(h.pi.api, { events: fake.events });
	await h.session.refresh();
	return {
		...h, fake,
		open: (u) => h.call("lane_open", { unit: u }),
		merge: (u) => h.call("lane_merge", { unit: u }),
		lanePath: (u) => join(h.root, ".worktrees", `per-ip-cap--${u}`),
	};
}

const ok = (out: ToolOut): ToolOut => {
	if (out.isError) throw new Error(textOf(out));
	return out;
};

/** Writes and commits `files` in the unit's lane, then refreshes. */
async function laneCommit(h: LaneHarness, u: string, files: Record<string, string>): Promise<string> {
	const path = h.lanePath(u);
	for (const [p, t] of Object.entries(files)) await writeIn(path, p, t);
	commitAll(path, `work ${u}`);
	await h.session.refresh();
	return createGit(path).head();
}

/** A settled implementer run of `u`, as the parent records it. */
const implemented = (h: LaneHarness, u: string, attempt = 1) =>
	h.seed("dispatch", `dispatch.${u}.implementer.${attempt}`, {
		role: "implementer", unit: u, attempt, packet: "p", agentSource: "s", requested: { thinking: "low" }, effective: {},
		status: "DONE", commits: [], notes: "n", discoveries: [], sources_used: [],
	});

/** Opens, starts and implements `u` in its lane with `files` committed there. */
async function laneDone(h: LaneHarness, u: string, files: Record<string, string>): Promise<string> {
	ok(await h.open(u));
	ok(await h.start(u));
	const head = await laneCommit(h, u, files);
	await implemented(h, u);
	return head;
}

const kinds = async (h: UnitHarness, kind: string) => (await h.ofKind(kind)).map((m) => m.data as Record<string, unknown>);

describe("parallel-lanes tools", () => {
	test("Lane created", async () => {
		const h = await laneHarness();
		const out = ok(await h.open("U2"));
		const path = h.lanePath("U2");
		expect(textOf(out)).toContain(path);
		expect(h.git("-C", path, "branch", "--show-current")).toBe("livespec/per-ip-cap--lane-U2");
		expect(await kinds(h, "lane")).toEqual([{ unit: "U2", path, branch: "livespec/per-ip-cap--lane-U2", base: h.head }]);
		expect(gitStatus(h.root)).toEqual([]);
		ok(await h.start("U2"));
		const started = (await h.ofKind("unit-start")).at(-1)?.data as { pre: { sha: string } };
		expect(started.pre.sha).toBe(h.head);
		expect(cardState(h).step.next).toContain("implementer U2");
		ok(await h.call("subagent_dispatch", { role: "implementer", unit: "U2" }));
		expect(h.fake.spawned.at(-1)?.options.cwd).toBe(path);
		expect(h.fake.spawned.at(-1)?.options.metadata.lane).toBe("U2");
	});

	test("Open refused over the limit", async () => {
		const h = await laneHarness({ lanes: 1 });
		ok(await h.open("U2"));
		const before = (await h.marked()).length;
		const out = await h.open("U3");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("limit (lanes) is 1");
		expect(await h.marked()).toHaveLength(before);
		expect(existsSync(h.lanePath("U3"))).toBe(false);
	});

	test("Leftover worktree", async () => {
		const h = await laneHarness();
		await writeIn(h.root, "extra.txt", "x\n");
		commitAll(h.root, "advance");
		await h.session.refresh();
		await createGit(h.root).worktreeAdd(h.lanePath("U2"), h.head);
		const out = await h.open("U2");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(h.lanePath("U2"));
		expect(await h.ofKind("lane")).toHaveLength(0);
	});

	test("a clean leftover worktree at HEAD is reused", async () => {
		const h = await laneHarness();
		await createGit(h.root).worktreeAddBranch(h.lanePath("U2"), "livespec/per-ip-cap--lane-U2", h.head);
		ok(await h.open("U2"));
		expect(await h.ofKind("lane")).toHaveLength(1);
	});

	test("a leftover worktree on another branch or detached is refused, naming the branch found", async () => {
		const h = await laneHarness();
		await createGit(h.root).worktreeAddBranch(h.lanePath("U2"), "other-branch", h.head);
		const out = await h.open("U2");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("other-branch");
		await createGit(h.root).worktreeRemove(h.lanePath("U2"));
		await createGit(h.root).worktreeAdd(h.lanePath("U2"), h.head);
		const detached = await h.open("U2");
		expect(detached.isError).toBe(true);
		expect(textOf(detached)).toContain("detached");
		expect(await h.ofKind("lane")).toHaveLength(0);
	});

	test("Merge before review refused", async () => {
		const h = await laneHarness({ difficulty: "medium" });
		await laneDone(h, "U2", { "src/u2.ts": "x\n" });
		const before = (await h.marked()).length;
		const out = await h.merge("U2");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("reviewer U2 unit");
		expect(await h.marked()).toHaveLength(before);
		expect(cardState(h).step.next).toContain("reviewer U2 unit");
	});

	test("Two lanes finish: merged and ticked one at a time", async () => {
		const h = await laneHarness();
		await laneDone(h, "U2", { "src/u2.ts": "x\n" });
		await laneDone(h, "U3", { "src/u3.ts": "x\n" });
		expect(cardState(h).step.next).toContain("lane_merge U2");
		ok(await h.merge("U2"));
		expect(existsSync(h.lanePath("U2"))).toBe(false);
		expect(cardState(h).step.next).toContain("unit_finish");
		const early = await h.merge("U3");
		expect(early.isError).toBe(true);
		expect(textOf(early)).toContain("unit_finish U2");
		ok(await h.finish("U2"));
		expect((await h.units()).find((u) => u.id === "U2")?.done).toBe(true);
		ok(await h.merge("U3"));
		ok(await h.finish("U3"));
		expect((await h.units()).filter((u) => u.done).map((u) => u.id)).toEqual(["U2", "U3"]);
		expect(h.git("rev-list", "--merges", "--count", "HEAD")).toBe("2");
	});

	test("Files violation", async () => {
		const h = await laneHarness();
		await laneDone(h, "U2", { "src/u2.ts": "x\n", "src/other.ts": "y\n" });
		const head = h.git("rev-parse", "HEAD");
		const out = await h.merge("U2");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("files-violation");
		expect(h.git("rev-parse", "HEAD")).toBe(head);
		const summary = (await kinds(h, "finding-summary")).at(-1) as { findings: { kind: string; location: string }[] };
		expect(summary.findings).toEqual([expect.objectContaining({ kind: "files-violation", location: "src/other.ts:1" })]);
		expect(existsSync(h.lanePath("U2"))).toBe(false);
		expect(cardState(h).state.subagents.lanes).toEqual({});
		expect(cardState(h).step.dispatch).toEqual({ role: "implementer", unit: "U2", inline: false });
	});

	test("after a files violation and the sequential re-run, the human gate payload lists the finding", async () => {
		const h = await laneHarness({ difficulty: "medium" });
		const laneHead = await laneDone(h, "U2", { "src/u2.ts": "x\n", "src/other.ts": "y\n" });
		await seedSummary(h, { unit: "U2", head: laneHead });
		await h.merge("U2");
		const summary = (await kinds(h, "finding-summary")).at(-1) as { advisory: boolean; completed: boolean; system?: string; findings: { scope: string }[] };
		expect(summary).toMatchObject({ advisory: false, system: "files-violation" });
		expect(summary.findings[0]?.scope).toBe("out-of-scope");
		const { state } = cardState(h);
		const facts = { specsStat: "", specsFiles: [], issueUrl: "https://forge.example/o/r/issues/1" };
		const payload = gatePayload(state, h.session.pack.ok ? h.session.pack.pack : (undefined as never), "build", facts);
		expect(payload.summary).toContain("Out-of-scope findings");
		expect(payload.summary).toContain("src/other.ts");
		expect(payload.findings).toHaveLength(1);
		// The system record neither counts as a review round nor as a review of any head.
		expect(cardState(h).step.dispatch?.role).toBe("implementer");
	});

	test("a files violation never blocks unit_finish of the re-run unit", async () => {
		const h = await laneHarness({ difficulty: "medium" });
		const laneHead = await laneDone(h, "U2", { "src/u2.ts": "x\n", "src/other.ts": "y\n" });
		await seedSummary(h, { unit: "U2", head: laneHead });
		await h.merge("U2");
		expect(await h.ofKind("finding-summary")).toHaveLength(2);
		await h.commit({ "src/u2.ts": "x\n" });
		await seedSummary(h, { unit: "U2" });
		const out = await h.finish("U2");
		expect(out.isError).toBeFalsy();
		expect((await h.units()).find((u) => u.id === "U2")?.done).toBe(true);
	});

	test.each([
		["tracked changes", { "src/u2.ts": "changed\n" }],
		["untracked changes", { "src/new.ts": "n\n" }],
	])("a lane worktree with %s refuses lane_merge and is left untouched", async (_name, dirty) => {
		const h = await laneHarness();
		await laneDone(h, "U2", { "src/u2.ts": "x\n" });
		for (const [p, t] of Object.entries(dirty)) await writeIn(h.lanePath("U2"), p, t);
		const before = (await h.marked()).length;
		const head = h.git("rev-parse", "HEAD");
		const out = await h.merge("U2");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("uncommitted");
		expect(existsSync(h.lanePath("U2"))).toBe(true);
		expect(await h.marked()).toHaveLength(before);
		expect(h.git("rev-parse", "HEAD")).toBe(head);
	});

	test("lane_merge refuses a blocked unit", async () => {
		const h = await laneHarness();
		await laneDone(h, "U2", { "src/u2.ts": "x\n" });
		await h.seed("decision", "progress.U2", { point: "progress", subject: "U2", outcome: "stop", reason: "same failure" });
		expect(cardState(h).state.evidence.blocked).toHaveProperty("U2");
		const before = (await h.marked()).length;
		const out = await h.merge("U2");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("BLOCKED");
		expect(existsSync(h.lanePath("U2"))).toBe(true);
		expect(await h.marked()).toHaveLength(before);
	});

	test("lane_merge refuses an amended unit", async () => {
		const h = await laneHarness();
		await laneDone(h, "U2", { "src/u2.ts": "x\n" });
		await h.world.editBodyBehindBack(h.n, (await h.world.bodyOf(h.n)).replace("Verify: `sh check2.sh`", "Verify: `sh check2.sh --strict`"));
		await h.session.refresh();
		const before = (await h.marked()).length;
		const out = await h.merge("U2");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("unit_amend");
		expect(existsSync(h.lanePath("U2"))).toBe(true);
		expect(await h.marked()).toHaveLength(before);
	});

	test("unit_finish refuses a receipted, not-ticked unit with an open lane", async () => {
		const h = await laneHarness();
		await laneDone(h, "U2", { "src/u2.ts": "x\n" });
		const target = (await h.units()).find((u) => u.id === "U2") as Parameters<typeof unitDigest>[0];
		const start = (await h.ofKind("unit-start")).at(-1);
		await h.seed("receipt", "U2.r1", { unit: "U2", digest: unitDigest(target), verify: "sh check2.sh", pre: { sha: h.head, exit: 1 }, post: { sha: h.head, exit: 0 }, output: "", start: start?.id });
		expect(cardState(h).state.evidence.untickedReceipts).toContain("U2");
		const before = (await h.marked()).length;
		const out = await h.finish("U2");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("lane_merge");
		expect(await h.marked()).toHaveLength(before);
		expect(h.writes.written).toBe(0);
	});

	test("the system summary survives a later review and still reaches the gate payload", async () => {
		const h = await laneHarness({ difficulty: "medium" });
		const laneHead = await laneDone(h, "U2", { "src/u2.ts": "x\n", "src/other.ts": "y\n" });
		await seedSummary(h, { unit: "U2", head: laneHead });
		await h.merge("U2");
		await h.commit({ "src/u2.ts": "x\n" });
		await seedSummary(h, { unit: "U2", round: 2 });
		const facts = { specsStat: "", specsFiles: [], issueUrl: "https://forge.example/o/r/issues/1" };
		const payload = gatePayload(cardState(h).state, h.session.pack.ok ? h.session.pack.pack : (undefined as never), "build", facts);
		expect(payload.summary).toContain("src/other.ts");
		expect(payload.findings).toHaveLength(1);
	});

	test("unit_finish refuses while the unit has an open lane", async () => {
		const h = await laneHarness();
		await laneDone(h, "U2", { "src/u2.ts": "x\n" });
		const before = (await h.marked()).length;
		const out = await h.finish("U2");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("lane_merge");
		expect(await h.marked()).toHaveLength(before);
		expect(h.writes.written).toBe(0);
	});

	test("after a new commit on the change branch the old lane review no longer counts", async () => {
		const h = await laneHarness({ difficulty: "medium" });
		const laneHead = await laneDone(h, "U2", { "src/u2.ts": "x\n" });
		await seedSummary(h, { unit: "U2", head: laneHead });
		ok(await h.merge("U2"));
		await h.commit({ "src/extra.ts": "e\n" });
		expect(cardState(h).step.dispatch).toMatchObject({ role: "reviewer", unit: "U2" });
	});

	test("after an unmerged close the unit re-runs in the change worktree and finishes with a receipt", async () => {
		const h = await laneHarness();
		await laneDone(h, "U2", { "src/u2.ts": "x\n", "src/other.ts": "y\n" });
		await h.merge("U2");
		const step = cardState(h).step;
		expect(step.dispatch?.role).toBe("implementer");
		// The files-violation finding is informational: no gate comment is needed to finish.
		ok(await h.call("subagent_dispatch", { role: "implementer", unit: "U2" }));
		expect(h.fake.spawned.at(-1)?.options.cwd).toBe(h.root);
		await h.commit({ "src/u2.ts": "x\n" });
		ok(await h.finish("U2"));
		expect((await kinds(h, "receipt")).map((r) => r.unit)).toEqual(["U2"]);
	});

	test("merge conflict aborts and re-runs sequentially", async () => {
		const h = await laneHarness();
		ok(await h.open("U2"));
		ok(await h.start("U2"));
		await h.commit({ "src/u2.ts": "main\n" });
		await laneCommit(h, "U2", { "src/u2.ts": "lane\n" });
		await implemented(h, "U2");
		const head = h.git("rev-parse", "HEAD");
		const out = await h.merge("U2");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("conflicted");
		expect(h.git("rev-parse", "HEAD")).toBe(head);
		expect(gitStatus(h.root)).toEqual([]);
		expect(existsSync(h.lanePath("U2"))).toBe(false);
		expect(cardState(h).step.dispatch?.role).toBe("implementer");
	});

	test("Red after merge", async () => {
		const h = await laneHarness();
		ok(await h.open("U3"));
		ok(await h.start("U3"));
		await laneCommit(h, "U3", { "src/u3.ts": "x\n" });
		await implemented(h, "U3");
		await h.commit({ "src/broken.flag": "x\n" });
		const head = h.git("rev-parse", "HEAD");
		const out = await h.merge("U3");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("the merge was undone");
		expect(h.git("rev-parse", "HEAD")).toBe(head);
		const progress = (await h.ofKind("decision")).filter((m) => m.id === "progress.U3");
		expect(progress).toHaveLength(1);
		expect(cardState(h).state.counters["unit_attempts.U3"]).toBe(1);
		expect(existsSync(h.lanePath("U3"))).toBe(false);
		expect(cardState(h).step.dispatch?.role).toBe("implementer");
	});

	test("merged close accepts the lane-head review", async () => {
		const h = await laneHarness({ difficulty: "medium" });
		const laneHead = await laneDone(h, "U2", { "src/u2.ts": "x\n" });
		await seedSummary(h, { unit: "U2", head: laneHead });
		ok(await h.merge("U2"));
		expect(h.git("rev-parse", "HEAD^2")).toBe(laneHead);
		expect(cardState(h).step.next).toBe("Finish U2 with unit_finish once Verify passes.");
		ok(await h.finish("U2"));
	});

	test("Moved by a workspace provider", async () => {
		const h = await laneHarness({ facts: { facts: () => ({ cwd: "/elsewhere" }) } });
		ok(await h.open("U2"));
		ok(await h.start("U2"));
		const out = await h.call("subagent_dispatch", { role: "implementer", unit: "U2" });
		expect(textOf(out)).toContain("sequentially");
		expect(h.fake.aborted).toHaveLength(1);
		expect(existsSync(h.lanePath("U2"))).toBe(false);
		expect(cardState(h).state.subagents.lanes).toEqual({});
		expect(cardState(h).step.dispatch?.role).toBe("implementer");
	});

	test("a lane unit's reviewer packet carries the lane diff", async () => {
		const h = await laneHarness();
		ok(await h.open("U2"));
		ok(await h.start("U2"));
		const laneHead = await laneCommit(h, "U2", { "src/u2.ts": "export const laneWork = 1;\n" });
		const out = ok(await h.call("subagent_packet", { role: "reviewer", unit: "U2", subject: "unit" }));
		expect(textOf(out)).toContain(`diff:${h.head}..${laneHead}`);
	});

	test("both tools refuse in a child", async () => {
		const h = await laneHarness();
		h.fake.service.childSession = (() => ({ agentId: "a", agentType: "implementer", metadata: {} })) as never;
		const child = asChild(h.ctx);
		for (const name of ["lane_open", "lane_merge"]) {
			const out = (await h.pi.tools.get(name)?.execute("c", { unit: "U2" }, undefined, undefined, child)) as ToolOut;
			expect(out.isError).toBe(true);
			expect(textOf(out)).toContain("child session");
		}
		expect(await h.ofKind("lane")).toHaveLength(0);
	});
});
