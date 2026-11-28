import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { parseInitiative } from "../../src/core/initiative.ts";
import { resetGatesForTests } from "../../src/engine/gates.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { decisionBody, decisionComment } from "../../src/decide/records.ts";
import { filterMarked, writeMarked } from "../../src/forge/markers.ts";
import type { Forge, Issue, Version, WriteResult } from "../../src/forge/types.ts";
import type { MemoryWorld } from "../forge/memory-forge.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { fakeCtx } from "../hooks/fake-pi.ts";
import { runChangeSplit } from "../../src/tools/change-split.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	resetGatesForTests();
	await cleanupDirs();
});

type U = { id: string; covers: string; depends?: string[]; done?: boolean };

const block = (u: U): string =>
	[
		`### ${u.id} — Unit ${u.id}`,
		`Covers: ${u.covers}/Requirement: R`,
		"Difficulty: low",
		"Tags: []",
		`Files: src/${u.id}.ts`,
		"Done means:",
		"- [ok] it works",
		"Scenarios:",
		`- [ok] test/${u.id}.test.ts › works`,
		`Depends: ${u.depends?.join(", ") || "—"}`,
		`Verify: \`npm test -- ${u.id}\``,
		u.done ? "- [x] done" : "- [ ] pending",
	].join("\n");

const UNITS: U[] = [
	{ id: "U1", covers: "request-context", done: true },
	{ id: "U2", covers: "rate-limit" },
	{ id: "U4", covers: "audit-log" },
	{ id: "U5", covers: "admin-ui", depends: ["U2"] },
	{ id: "U6", covers: "admin-ui", depends: ["U5"] },
];

const body = (o: { initiative?: number; units?: U[] } = {}) =>
	`${o.initiative === undefined ? "" : `Initiative: #${o.initiative}\n`}Depends: —\nCapabilities: new [], modified [rate-limit, request-context, audit-log, admin-ui]\nProduct impact: —\n\n## Proposal\nCap each IP.\n\n## Design\nWindow.\n\n## Questions\n\n## Units\n${(o.units ?? UNITS).map(block).join("\n\n")}\n\n## Durable docs\n`;

/** Change `per-ip-cap` in `phase` with a locked plan; with `initiative`, the tracking issue is seeded right after it. */
async function harness(o: { phase?: string; initiative?: boolean; units?: U[]; forge?: (world: MemoryWorld) => Forge } = {}): Promise<ToolHarness & { tracking?: number }> {
	const first = await toolHarness({ change: { body: body({ ...(o.initiative ? { initiative: 2 } : {}), ...(o.units ? { units: o.units } : {}) }), phase: o.phase ?? "build" }, locked: true, ...(o.forge ? { forge: o.forge } : {}) });
	if (!o.initiative) return first;
	const tracking = await first.world.seedIssue({
		title: "limits",
		body: `Goal: Limit\nCapabilities: [rate-limit]\n\n## Changes\n- [ ] #${first.n} per-ip-cap — Depends: —\n- [ ] #9 other — Depends: #${first.n}\n`,
		labels: ["livespec:initiative"],
	});
	expect(tracking).toBe(2);
	await first.session.refresh();
	return { ...first, tracking };
}

const all = (h: ToolHarness) => h.world.forge.searchIssues({ state: "all" });
async function titled(h: ToolHarness, title: string): Promise<Issue> {
	const found = (await all(h)).filter((i) => i.title === title);
	expect(found).toHaveLength(1);
	return found[0] as Issue;
}
const marked = async (h: ToolHarness) => filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;

describe("change_split", () => {
	test("Split with a dependency on a unit that stays", async () => {
		const h = await harness();
		const before = h.session.card;
		expect(before.kind === "change" && before.state.lock.gates.plan).toMatchObject({ outcome: "approved" });
		const out = await h.call("change_split", { issue: h.n, units: ["U5", "U6"], into: "rate-limit-admin" });
		expect(out.isError, textOf(out)).toBeFalsy();
		const created = await titled(h, "rate-limit-admin");
		expect(out.details).toEqual({ number: created.number });
		expect(created.labels).toEqual(["livespec", "livespec:phase/shape"]);
		const c = parseChange(created.body);
		expect(c.units.map((u) => [u.id, u.done, u.statusText])).toEqual([
			["U5", false, "- [ ] pending"],
			["U6", false, "- [ ] pending"],
		]);
		expect(c.units[0]?.depends).toEqual(["U2"]);
		expect(c.header.depends).toEqual([`#${h.n}`]);
		expect(c.header.capabilities).toEqual({ new: [], modified: ["admin-ui"] });
		const kept = parseChange((await h.world.forge.getIssue(h.n)).body);
		expect(kept.units.map((u) => u.id)).toEqual(["U1", "U2", "U4"]);
		expect(kept.header.capabilities).toEqual({ new: [], modified: ["rate-limit", "request-context", "audit-log"] });
		const stale = (await marked(h)).filter((m) => m.kind === "stale");
		expect(stale).toHaveLength(1);
		expect(stale[0]?.data).toMatchObject({ phases: ["plan", "build", "review", "ship", "close"], after_plan: false });
		// The plan gate result no longer counts and #N is back in plan, so its gate must be approved again.
		const card = h.session.card;
		expect(card.kind === "change" && card.state.lock.gates.plan).toBeUndefined();
		expect(card.kind === "change" && card.step.phase).toBe("plan");
		// With classification records and the plan skill noted, the next step on #N asks for the plan gate.
		for (const u of kept.units) {
			for (const [point, outcome] of [["tags", []], ["difficulty", "low"]] as const) {
				await h.world.postComment(h.n, BOT_LOGIN, decisionBody(decisionComment({ point, subject: u.id, digest: unitDigest(u), source: "rule", outcome, reason: "r" })));
			}
		}
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("skill-note", "plan.planning-and-task-breakdown", { phase: "plan", skill: "planning-and-task-breakdown", reason: "r" }));
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		const after = h.session.card;
		expect(after.kind === "change" && after.step.next).toMatch(/spec_gate|plan gate/);
	});

	test("Split during build returns to plan", async () => {
		const h = await harness();
		const out = await h.call("change_split", { issue: h.n, units: ["U4"], into: "x" });
		expect(out.isError, textOf(out)).toBeFalsy();
		const issue = await h.world.forge.getIssue(h.n);
		expect(issue.labels).toContain("livespec:phase/plan");
		expect(issue.labels).not.toContain("livespec:phase/build");
		expect(parseChange(issue.body).units.find((u) => u.id === "U1")?.done).toBe(true);
		// No Depends on a unit that stays: no Depends line and no generated initiative.
		expect(parseChange((await titled(h, "x")).body).header.depends).toEqual([]);
		expect((await all(h)).some((i) => i.labels.includes("livespec:initiative"))).toBe(false);
	});

	test("the new entry goes right after #N's entry in its initiative", async () => {
		const h = await harness({ initiative: true });
		const out = await h.call("change_split", { issue: h.n, units: ["U5", "U6"], into: "rate-limit-admin" });
		expect(out.isError, textOf(out)).toBeFalsy();
		const m = (await titled(h, "rate-limit-admin")).number;
		const entries = parseInitiative((await h.world.forge.getIssue(2)).body).changes;
		expect(entries.map((e) => [e.number, e.depends])).toEqual([
			[h.n, []],
			[m, [h.n]],
			[9, [h.n]],
		]);
		expect(parseChange((await h.world.forge.getIssue(m)).body).header.initiative).toBe("#2");
	});

	test("without an initiative and with a dependency on #N, a per-ip-cap-split initiative is created", async () => {
		const h = await harness();
		await h.call("change_split", { issue: h.n, units: ["U5", "U6"], into: "rate-limit-admin" });
		const m = (await titled(h, "rate-limit-admin")).number;
		const tracking = await titled(h, "per-ip-cap-split");
		expect(tracking.labels).toEqual(["livespec:initiative"]);
		expect(parseInitiative(tracking.body).changes.map((e) => [e.number, e.name, e.depends])).toEqual([
			[h.n, "per-ip-cap", []],
			[m, "rate-limit-admin", [h.n]],
		]);
		for (const k of [h.n, m]) expect(parseChange((await h.world.forge.getIssue(k)).body).header.initiative).toBe(`#${tracking.number}`);
	});

	test("refusals write nothing", async () => {
		const h = await harness();
		const before = (await all(h)).length;
		const bodyBefore = (await h.world.forge.getIssue(h.n)).body;
		for (const params of [
			{ issue: h.n, units: ["U1"], into: "x" },
			{ issue: h.n, units: ["U4"], into: "Not Kebab" },
			{ issue: h.n, units: ["U4"], into: "per-ip-cap" },
			{ issue: h.n + 1, units: ["U4"], into: "x" },
		]) {
			const out = await h.call("change_split", params);
			expect(out.isError, JSON.stringify(params)).toBe(true);
			expect(textOf(out)).toContain("change_split refused");
		}
		expect((await all(h)).length).toBe(before);
		expect((await h.world.forge.getIssue(h.n)).body).toBe(bodyBefore);
		expect((await marked(h)).some((m) => m.kind === "stale")).toBe(false);
	});

	test("already in plan: no label move, the stale comment is still posted", async () => {
		const h = await harness({ phase: "plan" });
		const out = await h.call("change_split", { issue: h.n, units: ["U4"], into: "x" });
		expect(out.isError, textOf(out)).toBeFalsy();
		expect((await h.world.forge.getIssue(h.n)).labels.filter((l) => l.startsWith("livespec:phase/"))).toEqual(["livespec:phase/plan"]);
		expect((await marked(h)).filter((m) => m.kind === "stale")).toHaveLength(1);
	});

	test("refuses when every unit would move", async () => {
		const h = await harness({ units: UNITS.filter((u) => !u.done) });
		const before = (await all(h)).length;
		const out = await h.call("change_split", { issue: h.n, units: ["U2", "U4", "U5", "U6"], into: "x" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toMatch(/every unit would move/);
		expect((await all(h)).length).toBe(before);
		expect((await marked(h)).some((m) => m.kind === "stale")).toBe(false);
	});

	test("refuses when the generated <title>-split initiative name is taken", async () => {
		const h = await harness();
		await h.world.seedIssue({ title: "per-ip-cap-split", body: "Goal: g\nCapabilities: []\n\n## Changes\n", labels: ["livespec:initiative"] });
		const before = (await all(h)).length;
		const bodyBefore = (await h.world.forge.getIssue(h.n)).body;
		const out = await h.call("change_split", { issue: h.n, units: ["U5", "U6"], into: "rate-limit-admin" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toMatch(/per-ip-cap-split/);
		expect((await all(h)).length).toBe(before);
		expect((await h.world.forge.getIssue(h.n)).body).toBe(bodyBefore);
		expect((await marked(h)).some((m) => m.kind === "stale")).toBe(false);
	});

	test("a conflict at the #N body write names the new issue and the remaining steps", async () => {
		let n = 0;
		const conflicting = (world: MemoryWorld): Forge =>
			new Proxy(world.forge, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (prop !== "updateIssueBody" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
					return async (k: number, b: string, expect: Version): Promise<WriteResult<Issue>> => {
						if (k === n) return { status: "conflict", current: expect, changed: ["body"] };
						return value.call(target, k, b, expect);
					};
				},
			});
		const h = await harness({ forge: conflicting });
		n = h.n;
		const out = await h.call("change_split", { issue: h.n, units: ["U5", "U6"], into: "rate-limit-admin" });
		expect(out.isError).toBe(true);
		const m = (await titled(h, "rate-limit-admin")).number;
		expect(out.details).toEqual({ number: m });
		const text = textOf(out);
		expect(text).toContain(`created #${m}`);
		expect(text).toMatch(/close or rename the orphan issue #\d+/i);
		expect(text).toMatch(/remove U5, U6 from #\d+/);
		expect(text).toMatch(/Not done: remove U5, U6 from #\d+; post the stale comment/);
		expect((await marked(h)).some((x) => x.kind === "stale")).toBe(false);
	});

	test("an error after the new issue exists is reported with what was written", async () => {
		let n = 0;
		const failing = (world: MemoryWorld): Forge =>
			new Proxy(world.forge, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (prop !== "createComment" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
					return async (k: number, b: string) => {
						if (k === n && b.includes("stale")) throw new Error("forge down");
						return value.call(target, k, b);
					};
				},
			});
		const h = await harness({ forge: failing });
		n = h.n;
		const out = await h.call("change_split", { issue: h.n, units: ["U5", "U6"], into: "rate-limit-admin" });
		expect(out.isError).toBe(true);
		const text = textOf(out);
		expect(text).toContain("forge down");
		expect(text).toMatch(/removed U5, U6 from #/);
		// afterForgeWrite ran on the failure path: the refreshed card already reads #N without U5 and U6.
		const card = h.session.card;
		expect(card.kind === "change" && card.state.change.units.map((u) => u.id)).toEqual(["U1", "U2", "U4"]);
		expect(text).toMatch(/close or rename the orphan issue #\d+/i);
	});

	test("refuses in a child session", async () => {
		const h = await harness();
		const child = { ...fakeCtx(h.root, true), sessionManager: { getHeader: () => ({ parentSession: "p" }) } } as never;
		const out = await runChangeSplit({ issue: h.n, units: ["U4"], into: "x" }, child);
		expect(out.isError).toBe(true);
		expect((await all(h)).some((i) => i.title === "x")).toBe(false);
	});
});
