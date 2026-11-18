import { afterEach, describe, expect, test, vi } from "vitest";
import extension from "../../src/extension.ts";
import { renderCard } from "../../src/hooks/phase-card.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { registerSettleCondition, resetSettleConditionsForTests } from "../../src/hooks/settle.ts";
import { writeIn } from "../helpers/repo.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "../tools/helpers.ts";
import { type UnitHarness, type UnitSpec, changeBody, unitHarness } from "../tools/unit-helpers.ts";
import { FakePi, fakeCtx } from "./fake-pi.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettleConditionsForTests();
	setSession(undefined);
	await cleanupDirs();
});

const SCRIPTS = { "check.sh": "test -f src/u1.ts\n", "check2.sh": "test -f src/u2.ts\n" };
const U1: UnitSpec = { id: "U1", verify: "sh check.sh" };
const U2: UnitSpec = { id: "U2", verify: "sh check2.sh" };

type Continuation = { entries: { type: string; customType: string; content: string; display: boolean }[]; continue: boolean } | undefined;

type Settler = { settle(outcome?: string): Promise<Continuation>; settled(aborted?: boolean): Promise<unknown> };

/** The whole extension on a fake pi, firing the settle events of one run. */
function settler(h: ToolHarness): Settler {
	const pi = new FakePi();
	extension(pi.api as never);
	const ctx = fakeCtx(h.root);
	const event = (outcome: string) => ({ type: "agent_before_settle", entries: [], continue: false, context: {}, outcome });
	return {
		settle: async (outcome = "completed") => (await pi.fire("agent_before_settle", event(outcome), ctx)) as Continuation,
		settled: (aborted = false) => pi.fire("agent_settled", { type: "agent_settled", aborted }, ctx),
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
		expect((await s.settle())?.continue).toBe(true);
		const before = (await h.world.forge.listComments(h.n)).length;
		// Read-only mode while the cached state is still readable: an unreachable forge leaves the cache read-only.
		vi.spyOn(h.forge, "isReadOnly").mockReturnValue(true);
		const errors = h.session.errors.length;
		expect(await s.settle()).toBeUndefined();
		expect(await h.world.forge.listComments(h.n)).toHaveLength(before);
		expect(await incompletes(h)).toEqual([]);
		const warnings = h.session.errors.slice(errors);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toBe("settle: unfinished work unknown: the forge is in read-only mode; nothing was written");
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

	test("a failing condition is recorded and the agent settles", async () => {
		const h = await u2Started();
		registerSettleCondition("broken", () => {
			throw new Error("condition exploded");
		});
		expect(await settler(h).settle()).toBeUndefined();
		expect(h.session.errors.some((e) => e.startsWith("settle:") && e.includes("condition exploded"))).toBe(true);
	});
});
