import { afterEach, describe, expect, test, vi } from "vitest";
import extension from "../../src/extension.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { renderCard } from "../../src/hooks/phase-card.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { registerSettleCondition, resetSettleConditionsForTests } from "../../src/hooks/settle.ts";
import { writeIn } from "../helpers/repo.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "../tools/helpers.ts";
import { type UnitHarness, type UnitSpec, changeBody, unitHarness } from "../tools/unit-helpers.ts";
import { type FakeCtx, FakePi, asChild, fakeCtx } from "./fake-pi.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettleConditionsForTests();
	setSession(undefined);
	await cleanupDirs();
});

const SCRIPTS = { "check.sh": "test -f src/u1.ts\n", "check2.sh": "test -f src/u2.ts\n", "check3.sh": "test -f src/u3.ts\n", "check4.sh": "test -f src/u4.ts\n" };
const U1: UnitSpec = { id: "U1", verify: "sh check.sh" };
const U2: UnitSpec = { id: "U2", verify: "sh check2.sh" };
const U3: UnitSpec = { id: "U3", verify: "sh check3.sh" };
const U4: UnitSpec = { id: "U4", verify: "sh check4.sh" };

type Continuation = { entries: { type: string; customType: string; content: string; display: boolean }[]; continue: boolean } | undefined;

type Settler = {
	settle(outcome?: string, ctx?: FakeCtx): Promise<Continuation>;
	settled(aborted?: boolean, ctx?: FakeCtx): Promise<unknown>;
	ctx: FakeCtx;
};

/** The whole extension on a fake pi, firing the settle events of one run; `ctx` defaults to the main session. */
function settler(h: ToolHarness): Settler {
	const pi = new FakePi();
	extension(pi.api as never);
	const main = fakeCtx(h.root);
	const event = (outcome: string) => ({ type: "agent_before_settle", entries: [], continue: false, context: {}, outcome });
	return {
		settle: async (outcome = "completed", ctx: FakeCtx = main) => (await pi.fire("agent_before_settle", event(outcome), ctx)) as Continuation,
		settled: (aborted = false, ctx: FakeCtx = main) => pi.fire("agent_settled", { type: "agent_settled", aborted }, ctx),
		ctx: main,
	};
}

/** A build change with U1 and U2, U2 started red. */
async function u2Started(units: UnitSpec[] = [U1, U2]): Promise<UnitHarness> {
	const h = await unitHarness({ units, scripts: SCRIPTS });
	const out = await h.start("U2");
	if (out.isError) throw new Error(textOf(out));
	return h;
}

type Incomplete = { items: string[]; at: string; head_sha: string };
const incompletes = async (h: UnitHarness) => (await h.ofKind("incomplete")).map((m) => ({ id: m.id, data: m.data as Incomplete }));

const cardOf = (h: ToolHarness) => renderCard(h.session.card);

/** Finishes U2 green: commits its file and runs `unit_finish U2`. */
async function finishU2(h: UnitHarness): Promise<void> {
	await h.commit({ "src/u2.ts": "x\n" });
	const out = await h.finish("U2");
	if (out.isError) throw new Error(textOf(out));
}

/** Settles twice so the own `incomplete` comment lists the unfinished items, then ends the run. */
async function recordedRun(s: Settler): Promise<void> {
	await s.settle();
	await s.settle();
	await s.settled();
}

/** Starts U3 through `unit_start`, and seeds U4's start: only one unit can be started per worktree. */
async function startU3U4(h: UnitHarness): Promise<void> {
	const out = await h.start("U3");
	if (out.isError) throw new Error(textOf(out));
	const u4 = (await h.units()).find((u) => u.id === "U4");
	if (!u4) throw new Error("U4 missing");
	await h.seed("unit-start", "U4.s", { unit: "U4", digest: unitDigest(u4), verify: u4.verify, pre: { sha: h.git("rev-parse", "HEAD") } });
}

describe("settle-continuation", () => {
	test("Not in build", async () => {
		const h = await toolHarness({ change: { body: changeBody([U1]), phase: "define" } });
		await writeIn(h.root, "scratch.txt", "dirty\n");
		const before = (await h.world.forge.listComments(h.n)).length;
		const s = settler(h);
		expect(await s.settle()).toBeUndefined();
		expect(await s.settle()).toBeUndefined();
		expect(await h.world.forge.listComments(h.n)).toHaveLength(before);
	});

	test("Registered condition", async () => {
		const h = await unitHarness({ units: [U1, U2], scripts: SCRIPTS });
		registerSettleCondition("review", () => "review pending for U2");
		const out = await settler(h).settle();
		expect(out?.continue).toBe(true);
		const message = out?.entries.at(-1);
		expect(message).toMatchObject({ type: "custom_message", customType: "livespec-settle", display: true });
		expect(message?.content).toContain("review pending for U2");
	});

	test("Exactly one continuation", async () => {
		const h = await u2Started();
		const s = settler(h);
		const first = await s.settle();
		expect(first?.continue).toBe(true);
		expect(first?.entries.at(-1)?.content).toContain("U2");
		expect(await s.settle()).toBeUndefined();
		expect(await s.settle()).toBeUndefined();
	});

	test("New prompt gets a new continuation", async () => {
		const h = await u2Started();
		const s = settler(h);
		expect((await s.settle())?.continue).toBe(true);
		expect(await s.settle()).toBeUndefined();
		await s.settled();
		expect((await s.settle())?.continue).toBe(true);
	});

	test("Incomplete posted and shown", async () => {
		const h = await u2Started();
		const s = settler(h);
		await s.settle();
		await s.settle();
		const written = await incompletes(h);
		expect(written).toHaveLength(1);
		expect(written[0]?.id).toBe(String(h.n));
		expect(written[0]?.data.items.join("\n")).toContain("U2");
		expect(written[0]?.data.head_sha).toBe(h.git("rev-parse", "HEAD"));
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		expect(cardOf(h)).toMatch(/^Incomplete: .*U2/m);
		// A later run that still ends with U2 started edits the same comment in place.
		await s.settled();
		await s.settle();
		await s.settle();
		expect(await incompletes(h)).toHaveLength(1);
	});

	test("Cleared after finishing", async () => {
		const h = await u2Started();
		const s = settler(h);
		await s.settle();
		await s.settle();
		await s.settled();
		await finishU2(h);
		expect(await s.settle()).toBeUndefined();
		const written = await incompletes(h);
		expect(written).toHaveLength(1);
		expect(written[0]?.data.items).toEqual([]);
		await h.session.refresh();
		expect(cardOf(h)).not.toContain("Incomplete:");
	});

	test("Cleared after the phase moved on", async () => {
		const h = await u2Started([U2]);
		const s = settler(h);
		await s.settle();
		await s.settle();
		await s.settled();
		await finishU2(h);
		expect((await h.world.forge.getIssue(h.n)).labels).toContain("livespec:phase/review");
		expect(await s.settle()).toBeUndefined();
		expect((await incompletes(h))[0]?.data.items).toEqual([]);
	});

	test("Read-only forge", async () => {
		const h = await u2Started();
		const s = settler(h);
		await recordedRun(s);
		const before = (await h.world.forge.listComments(h.n)).length;
		// Read-only mode while the cached state is still readable: an unreachable forge leaves the cache read-only.
		vi.spyOn(h.forge, "isReadOnly").mockReturnValue(true);
		const errors = h.session.errors.length;
		expect(await s.settle()).toBeUndefined();
		expect(await h.world.forge.listComments(h.n)).toHaveLength(before);
		expect((await incompletes(h))[0]?.data.items).toEqual(["U2 is started"]);
		const warnings = h.session.errors.slice(errors);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toBe("settle: unfinished work unknown: the forge is in read-only mode; nothing was written");
		expect(s.ctx.ui.notify).toHaveBeenCalledTimes(1);
		const [message, type] = s.ctx.ui.notify.mock.calls[0] ?? [];
		expect(message).toContain(`#${h.n}`);
		expect(message).toContain("read-only");
		expect(type).toBe("warning");
	});

	test("an unreachable forge at the second settle records a warning and writes nothing", async () => {
		const h = await u2Started();
		const s = settler(h);
		expect((await s.settle())?.continue).toBe(true);
		const before = (await h.world.forge.listComments(h.n)).length;
		await h.world.makeUnreachable();
		const errors = h.session.errors.length;
		expect(await s.settle()).toBeUndefined();
		const warnings = h.session.errors.slice(errors).filter((e) => e.startsWith("settle:"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toBe("settle: unfinished work unknown: the forge is in read-only mode; nothing was written");
		// The login is unknown, so no own comments are read and there is nothing to notify (design Risks).
		expect(s.ctx.ui.notify).not.toHaveBeenCalled();
		await h.world.restore();
		expect(await h.world.forge.listComments(h.n)).toHaveLength(before);
		expect(await incompletes(h)).toEqual([]);
	});

	test("an unreachable forge at the first settle requests no continuation", async () => {
		const h = await u2Started();
		const s = settler(h);
		await h.world.makeUnreachable();
		expect(await s.settle()).toBeUndefined();
		expect(h.session.errors.filter((e) => e.startsWith("settle: unfinished work unknown: "))).toHaveLength(1);
		await h.world.restore();
		// The flag was not spent: the next readable settle still gets its one continuation.
		expect((await s.settle())?.continue).toBe(true);
	});

	test("an aborted outcome returns nothing", async () => {
		const h = await u2Started();
		const s = settler(h);
		expect(await s.settle("aborted")).toBeUndefined();
		expect(await s.settle("error")).toBeUndefined();
		expect((await s.settle())?.continue).toBe(true);
		expect(await incompletes(h)).toEqual([]);
	});

	test("a child settle neither refreshes the parent nor writes its incomplete comment", async () => {
		const h = await u2Started();
		const s = settler(h);
		expect((await s.settle())?.continue).toBe(true);
		const refresh = vi.spyOn(h.session, "refresh");
		const before = (await h.world.forge.listComments(h.n)).length;
		const child = asChild(fakeCtx(h.root));
		expect(await s.settle("completed", child)).toBeUndefined();
		expect(await s.settle("completed", child)).toBeUndefined();
		expect(refresh).not.toHaveBeenCalled();
		expect(await h.world.forge.listComments(h.n)).toHaveLength(before);
		expect(await incompletes(h)).toEqual([]);
	});

	test("a child settled leaves the parent's asked flag set", async () => {
		const h = await u2Started();
		const s = settler(h);
		expect((await s.settle())?.continue).toBe(true);
		await s.settled(false, asChild(fakeCtx(h.root)));
		expect(await s.settle()).toBeUndefined();
		expect(await incompletes(h)).toHaveLength(1);
	});

	test("a failing condition is recorded and the agent settles", async () => {
		const h = await u2Started();
		registerSettleCondition("broken", () => {
			throw new Error("condition exploded");
		});
		expect(await settler(h).settle()).toBeUndefined();
		expect(h.session.errors.some((e) => e.startsWith("settle:") && e.includes("condition exploded"))).toBe(true);
	});

	test("Rewritten at the continuation settle", async () => {
		// naicoi92/iroh-tunnel#268: a pending U1 would block the advance to review, so the change has no U1.
		const h = await u2Started([U2, U3, U4]);
		const s = settler(h);
		await recordedRun(s);
		expect((await incompletes(h))[0]?.data.items).toEqual(["U2 is started"]);
		await finishU2(h);
		await startU3U4(h);
		expect((await s.settle())?.continue).toBe(true);
		expect((await incompletes(h))[0]?.data.items).toEqual(["U3 is started", "U4 is started"]);
		// Both receipts move the change to review, and the next run clears the comment.
		await h.commit({ "src/u3.ts": "x\n" });
		expect((await h.finish("U3")).isError).toBeFalsy();
		await h.commit({ "src/u4.ts": "x\n" });
		expect((await h.finish("U4")).isError).toBeFalsy();
		expect((await h.world.forge.getIssue(h.n)).labels).toContain("livespec:phase/review");
		await s.settled();
		expect(await s.settle()).toBeUndefined();
		expect((await incompletes(h))[0]?.data.items).toEqual([]);
		await h.session.refresh();
		expect(cardOf(h)).not.toContain("Incomplete");
	});

	test("No first comment before the continuation", async () => {
		const h = await u2Started();
		expect((await settler(h).settle())?.continue).toBe(true);
		expect(await incompletes(h)).toEqual([]);
	});

	test("Equal items are not rewritten", async () => {
		const h = await u2Started();
		const s = settler(h);
		await recordedRun(s);
		const before = (await h.world.forge.listComments(h.n)).length;
		const update = vi.spyOn(h.forge, "updateComment");
		await s.settle();
		await s.settle();
		expect(update).not.toHaveBeenCalled();
		expect(await h.world.forge.listComments(h.n)).toHaveLength(before);
	});

	test("Rewritten after the continuation", async () => {
		const h = await u2Started([U2, U3]);
		const s = settler(h);
		await recordedRun(s);
		expect((await s.settle())?.continue).toBe(true);
		await finishU2(h);
		const out = await h.start("U3");
		if (out.isError) throw new Error(textOf(out));
		expect(await s.settle()).toBeUndefined();
		expect((await incompletes(h))[0]?.data.items).toEqual(["U3 is started"]);
	});

	test("reordered items are rewritten", async () => {
		const h = await unitHarness({ units: [U1, U2], scripts: SCRIPTS });
		let flip = false;
		registerSettleCondition("a", () => (flip ? "y" : "x"));
		registerSettleCondition("b", () => (flip ? "x" : "y"));
		const s = settler(h);
		await recordedRun(s);
		expect((await incompletes(h))[0]?.data.items).toEqual(["x", "y"]);
		flip = true;
		await s.settle();
		expect((await incompletes(h))[0]?.data.items).toEqual(["y", "x"]);
	});

	test("Failed rewrite keeps the continuation", async () => {
		const h = await u2Started([U2, U3]);
		const s = settler(h);
		await recordedRun(s);
		await finishU2(h);
		const out = await h.start("U3");
		if (out.isError) throw new Error(textOf(out));
		vi.spyOn(h.forge, "updateComment").mockRejectedValue(new Error("transport failed"));
		const errors = h.session.errors.length;
		expect((await s.settle())?.continue).toBe(true);
		expect(h.session.errors.slice(errors).some((e) => e.startsWith("settle:") && e.includes("transport failed"))).toBe(true);
		expect(s.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("transport failed"), "warning");
	});

	test("a refused write at the continuation settle keeps the continuation", async () => {
		const h = await u2Started([U2, U3]);
		const s = settler(h);
		await recordedRun(s);
		await finishU2(h);
		const out = await h.start("U3");
		if (out.isError) throw new Error(textOf(out));
		h.session.accountBlock = "blocked";
		expect((await s.settle())?.continue).toBe(true);
		expect((await incompletes(h))[0]?.data.items).toEqual(["U2 is started"]);
	});

	test("Stale state is notified", async () => {
		const h = await u2Started();
		const s = settler(h);
		await recordedRun(s);
		await h.session.refresh();
		const card = h.session.card;
		if (card.kind !== "change") throw new Error(`card is ${card.kind}`);
		vi.spyOn(h.session, "refresh").mockImplementation(async () => {
			h.session.card = { ...card, state: { ...card.state, stale: true } };
		});
		const before = (await h.world.forge.listComments(h.n)).length;
		const errors = h.session.errors.length;
		expect(await s.settle()).toBeUndefined();
		expect(await h.world.forge.listComments(h.n)).toHaveLength(before);
		expect((await incompletes(h))[0]?.data.items).toEqual(["U2 is started"]);
		expect(h.session.errors.slice(errors)).toEqual(["settle: unfinished work unknown: the change state is stale; nothing was written"]);
		expect(s.ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(s.ctx.ui.notify).toHaveBeenCalledWith(`livespec: the incomplete comment of #${h.n} was not updated: the change state is stale`, "warning");
	});

	test("a throwing notify does not break settle", async () => {
		const h = await u2Started();
		const s = settler(h);
		await recordedRun(s);
		s.ctx.ui.notify.mockImplementation(() => {
			throw new Error("ui gone");
		});
		vi.spyOn(h.forge, "isReadOnly").mockReturnValue(true);
		const errors = h.session.errors.length;
		expect(await s.settle()).toBeUndefined();
		expect(s.ctx.ui.notify).toHaveBeenCalledTimes(1);
		// Swallowed by the guard, not by the hook's outer catch.
		expect(h.session.errors.slice(errors).some((e) => e.includes("ui gone"))).toBe(false);
	});

	test("Unknown state without items is quiet", async () => {
		const h = await u2Started();
		const s = settler(h);
		vi.spyOn(h.forge, "isReadOnly").mockReturnValue(true);
		const errors = h.session.errors.length;
		expect(await s.settle()).toBeUndefined();
		expect(h.session.errors.slice(errors)).toEqual(["settle: unfinished work unknown: the forge is in read-only mode; nothing was written"]);
		expect(s.ctx.ui.notify).not.toHaveBeenCalled();
	});

	test("Refused write is notified", async () => {
		const h = await u2Started();
		const s = settler(h);
		await recordedRun(s);
		await finishU2(h);
		h.session.accountBlock = "blocked";
		const update = vi.spyOn(h.forge, "updateComment");
		const errors = h.session.errors.length;
		expect(await s.settle()).toBeUndefined();
		expect(update).not.toHaveBeenCalled();
		expect((await incompletes(h))[0]?.data.items).toEqual(["U2 is started"]);
		expect(h.session.errors.slice(errors).some((e) => e.startsWith("settle: incomplete items not written:") && e.includes("blocked"))).toBe(true);
		expect(s.ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(s.ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^livespec: the incomplete comment of #${h.n} was not updated: .*blocked`)), "warning");
	});
});
