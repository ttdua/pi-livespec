import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { setHeaderLine } from "../../src/core/sections.ts";
import type { UnitInput } from "../../src/core/unit-blocks.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { CHANGE_BODY_TEMPLATE } from "../../src/tools/change-new.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import type { SelectFn } from "../hooks/fake-pi.ts";
import { CHANGE_BRANCH } from "../hooks/helpers.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const COVERS = "rate-limit/Requirement: Per-IP cap";
const AT = "2026-11-15T10:00:00.000Z";

function unit(title: string, file: string, label: string, extra: Partial<UnitInput> = {}): UnitInput {
	return {
		title,
		covers: [COVERS],
		files: [file],
		done_means: [{ label, text: `${title} works` }],
		scenarios: [{ label, ref: `test/${label}.test.ts › ${title}` }],
		depends: [],
		verify: `bun test ${label}`,
		...extra,
	};
}

const U1 = unit("Counter", "src/limits/counter.ts", "c");
const U2 = unit("Readme note", "README.md", "r");

/** Every select of the in-session human: the request summary picks approve; follow-ups keep everything. */
type Human = { summaries: string[]; pick: string | undefined };

function humanUI(human: Human): { hasUI: true; select: SelectFn } {
	return {
		hasUI: true,
		select: async (title, options) => {
			if (title === "Add notes?") return "No notes";
			if (title === "Adjust Difficulty or Tags?") return "Keep classification";
			human.summaries.push(title);
			return options.find((o) => o === human.pick);
		},
	};
}

type Amend = ToolHarness & { n: number; human: Human; amend(params: unknown): ReturnType<ToolHarness["call"]> };

/** A planned two-unit change (U1, U2) through plan_units, locked by an approved plan gate unless `locked` is false. */
async function planned(o: { locked?: boolean; units?: UnitInput[] } = {}): Promise<Amend> {
	const human: Human = { summaries: [], pick: "approve" };
	const h = await toolHarness({ branch: CHANGE_BRANCH, ui: humanUI(human) });
	h.git("config", "user.name", "t");
	h.git("config", "user.email", "t@t");
	h.git("config", `branch.${CHANGE_BRANCH}.livespecBase`, h.head);
	const body = setHeaderLine(setHeaderLine(CHANGE_BODY_TEMPLATE, "Base", h.head), "Branch", CHANGE_BRANCH);
	const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", "livespec:phase/plan"] });
	await h.session.refresh();
	const out = await h.call("plan_units", { units: o.units ?? [U1, U2] });
	if (out.isError) throw new Error(textOf(out));
	const a: Amend = { ...h, n, human, amend: (params) => h.call("unit_amend", params) };
	if (o.locked !== false) await lock(a);
	return a;
}

async function lock(h: Amend): Promise<void> {
	const locked = Object.fromEntries(parseChange(await h.world.bodyOf(h.n)).units.map((u) => [u.id, unitDigest(u)]));
	const data = { phase: "plan", outcome: "approved", notes: "", by: "alice", at: AT, adapter: "in-session", head_sha: h.head, waivers: [], locked };
	await h.world.postComment(h.n, BOT_LOGIN, writeMarked("gate", "plan.self-1", data));
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
}

async function marked(h: Amend): Promise<MarkedComment[]> {
	return filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
}

const ofKind = async (h: Amend, kind: string) => (await marked(h)).filter((m) => m.kind === kind);
const units = async (h: Amend) => parseChange(await h.world.bodyOf(h.n)).units;

function lockState(h: Amend) {
	const card = h.session.card;
	if (card.kind !== "change") throw new Error(`no change card: ${card.kind}`);
	return card.state.lock;
}

async function webEdit(h: Amend, edit: (body: string) => string): Promise<void> {
	await h.world.editBodyBehindBack(h.n, edit(await h.world.bodyOf(h.n)));
	await h.session.refresh();
}

const tickU1 = (body: string) => body.replace(/(### U1 — [\s\S]*?)- \[ \] pending/, "$1- [x] done");

describe("unit_amend", () => {
	test("Amendment unfreezes", async () => {
		const h = await planned();
		await webEdit(h, (b) => b.replace("Verify: `bun test r`", "Verify: `bun test readme`"));
		expect(lockState(h).frozen).toEqual(["U2"]);
		const before = unitDigest((await units(h))[1]!);
		const out = await h.amend({ unit: "U2", replacement: { ...U2, verify: "bun test readme" } });
		expect(out.isError).toBe(false);
		const amendment = await ofKind(h, "amendment");
		expect(amendment).toHaveLength(1);
		const after = unitDigest((await units(h))[1]!);
		expect(amendment[0]?.data).toMatchObject({ action: "edit", unit: "U2", old: before, new: after, outcome: "approved" });
		expect(lockState(h).frozen).toEqual([]);
	});

	test("Add and drop", async () => {
		const h = await planned();
		const added = await h.amend({ add: true, replacement: unit("Burst", "src/limits/burst.ts", "b") });
		expect(added.isError).toBe(false);
		expect((await units(h)).map((u) => u.id)).toEqual(["U1", "U2", "U3"]);
		const u3 = (await units(h))[2]!;
		expect(lockState(h).locked?.U3).toBe(unitDigest(u3));
		const dropped = await h.amend({ drop: true, unit: "U1" });
		expect(dropped.isError).toBe(false);
		expect((await units(h)).map((u) => u.id)).toEqual(["U2", "U3"]);
		expect(Object.keys(lockState(h).locked ?? {}).sort()).toEqual(["U2", "U3"]);
		expect(lockState(h).frozen).toEqual([]);
	});

	test("Drop a done unit", async () => {
		const h = await planned();
		await webEdit(h, tickU1);
		const out = await h.amend({ drop: true, unit: "U1" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("done");
		expect(h.human.summaries).toEqual([]);
		expect((await units(h)).map((u) => u.id)).toEqual(["U1", "U2"]);
	});

	test("Invalid replacement", async () => {
		const h = await planned();
		const { verify: _verify, ...noVerify } = U2;
		const out = await h.amend({ unit: "U2", replacement: noVerify });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("units-format");
		expect(h.human.summaries).toEqual([]);
		expect(await ofKind(h, "request")).toEqual([]);
		expect(await ofKind(h, "answer")).toEqual([]);
	});

	test("Drop a depended-on unit", async () => {
		const h = await planned({ units: [U1, U2, unit("Header", "src/limits/header.ts", "h", { depends: ["U1"] })] });
		const out = await h.amend({ drop: true, unit: "U1" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("U3");
		expect(h.human.summaries).toEqual([]);
	});

	test("a dropped id is never reused by an add", async () => {
		const h = await planned();
		expect((await h.amend({ drop: true, unit: "U2" })).isError).toBe(false);
		expect((await h.amend({ add: true, replacement: unit("Burst", "src/limits/burst.ts", "b") })).isError).toBe(false);
		expect((await units(h)).map((u) => u.id)).toEqual(["U1", "U3"]);
	});

	test("refuses before a lock", async () => {
		const h = await planned({ locked: false });
		const out = await h.amend({ unit: "U2", replacement: { ...U2, verify: "bun test readme" } });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("plan_units");
		expect(h.human.summaries).toEqual([]);
	});

	test("refuses a call that is not exactly one form", async () => {
		const h = await planned();
		for (const params of [{}, { unit: "U2" }, { add: true }, { drop: true }, { drop: true, unit: "U1", add: true, replacement: U2 }, { unit: "U9", replacement: U2 }]) {
			expect((await h.amend(params)).isError).toBe(true);
		}
		expect(h.human.summaries).toEqual([]);
	});

	test("only the affected units are in the request", async () => {
		const h = await planned();
		await h.amend({ unit: "U2", replacement: { ...U2, verify: "bun test readme" } });
		expect(h.human.summaries).toHaveLength(1);
		const summary = h.human.summaries[0]!;
		expect(summary).toContain("### U2 — Readme note");
		expect(summary).toContain("Verify: `bun test readme`");
		expect(summary).toContain("Verify: `bun test r`");
		expect(summary.indexOf("Verify: `bun test r`")).toBeLessThan(summary.indexOf("Verify: `bun test readme`"));
		expect(summary.match(/### U2 — Readme note/g)).toHaveLength(2);
		expect(summary).not.toContain("U1");
		expect(summary).not.toContain("Counter");
	});

	test("amending U3 writes records tags.U3 and difficulty.U3", async () => {
		const h = await planned({ units: [U1, U2, unit("Header", "src/limits/header.ts", "h")] });
		const before = (await ofKind(h, "decision")).length;
		const out = await h.amend({ unit: "U3", replacement: unit("Header", "src/auth/header.ts", "h") });
		expect(out.isError).toBe(false);
		const added = (await ofKind(h, "decision")).slice(before);
		expect(added.map((m) => m.id)).toEqual(["tags.U3", "difficulty.U3"]);
		const u3 = (await units(h))[2]!;
		expect(added.map((m) => (m.data as { digest: string }).digest)).toEqual([unitDigest(u3), unitDigest(u3)]);
		expect(u3).toMatchObject({ tags: ["security"], difficulty: "high" });
		const card = h.session.card;
		if (card.kind !== "change") throw new Error("no change card");
		expect(card.state.checks.filter((c) => c.check === "unit-classification")).toEqual([]);
	});

	test("an edit keeps the unit's status line", async () => {
		const h = await planned();
		await webEdit(h, tickU1);
		const out = await h.amend({ unit: "U1", replacement: { ...U1, verify: "bun test counter" } });
		expect(out.isError).toBe(false);
		expect((await units(h))[0]).toMatchObject({ done: true, verify: "bun test counter" });
	});

	test("a dismissed amendment changes nothing", async () => {
		const h = await planned();
		h.human.pick = "dismiss";
		const before = await h.world.bodyOf(h.n);
		await h.amend({ add: true, replacement: unit("Burst", "src/limits/burst.ts", "b") });
		expect(await h.world.bodyOf(h.n)).toBe(before);
		expect(Object.keys(lockState(h).locked ?? {})).toEqual(["U1", "U2"]);
	});
});
