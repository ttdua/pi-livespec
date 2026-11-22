import { describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { exceededLimits, changeSize } from "../../src/initiatives/size-limits.ts";
import { planSplit, type SplitPlan } from "../../src/initiatives/split.ts";
import { stateFor } from "../helpers/change-state.ts";
import type { ChangeState } from "../../src/engine/state-types.ts";
import type { MarkedComment } from "../../src/forge/markers.ts";

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
	{ id: "U3", covers: "audit-log" },
	{ id: "U4", covers: "rate-limit" },
	{ id: "U5", covers: "admin-ui", depends: ["U2"] },
	{ id: "U6", covers: "admin-ui", depends: ["U5"] },
	{ id: "U7", covers: "rate-limit" },
];

const bodyOf = (units: U[], caps = "new [], modified [rate-limit, request-context, audit-log, admin-ui]") =>
	`Base: abc\nBranch: livespec/per-ip-cap\nDepends: —\nCapabilities: ${caps}\nProduct impact: —\n\n## Proposal\nCap.\n\n## Units\n${units.map(block).join("\n\n")}\n\n## Durable docs\n`;

const comment = (kind: string, id: string, data: unknown, i = 0): MarkedComment => ({ kind, id, data, commentId: `c${i}`, author: "bot" }) as unknown as MarkedComment;

function setup(units = UNITS, o: Partial<ChangeState> = {}, caps?: string) {
	const body = bodyOf(units, caps);
	return { change: parseChange(body), state: stateFor("build", { issue: { number: 35, title: "per-ip-cap", labels: [], state: "open" }, ...o }, body) };
}

function refusedOf(out: ReturnType<typeof planSplit>): string {
	if (!("refused" in out)) throw new Error("expected a refusal");
	return out.refused;
}

function planOf(out: ReturnType<typeof planSplit>): SplitPlan {
	if ("refused" in out) throw new Error(`refused: ${out.refused}`);
	return out;
}

describe("planSplit refusals", () => {
	test("Split refused when a remaining unit depends on a moved one", () => {
		const { change, state } = setup(UNITS.map((u) => (u.id === "U7" ? { ...u, depends: ["U5"] } : u)));
		const r = refusedOf(planSplit(change, state, ["U5", "U6"]));
		expect(r).toContain("U7");
		expect(r).toContain("U5");
	});

	test("Started unit cannot move", () => {
		const { change, state } = setup(UNITS, { evidence: { started: { U5: {} as never }, receipts: {}, attempts: {}, blocked: {}, untickedReceipts: [] } });
		expect(refusedOf(planSplit(change, state, ["U5", "U6"]))).toMatch(/U5.*started/);
	});

	test("a done unit cannot move", () => {
		const { change, state } = setup();
		expect(refusedOf(planSplit(change, state, ["U1"]))).toMatch(/U1.*done/);
	});

	test("an unknown unit cannot move", () => {
		const { change, state } = setup();
		expect(refusedOf(planSplit(change, state, ["U9"]))).toMatch(/U9/);
	});

	test("no units is refused", () => {
		const { change, state } = setup();
		expect(refusedOf(planSplit(change, state, []))).toMatch(/unit/);
	});

	test("a unit in an open lane cannot move", () => {
		const lane = comment("lane", "lane.U4", { unit: "U4", path: "/tmp/l", branch: "livespec/per-ip-cap--U4", base: "abc" });
		const { change, state } = setup(UNITS, { marked: [lane] });
		expect(refusedOf(planSplit(change, state, ["U4"]))).toMatch(/U4.*lane/);
	});

	test("Split refused while parked", () => {
		const { change, state } = setup(UNITS, { parkedCore: { index: 0, waitsFor: [34], units: [], at: "t" } });
		expect(refusedOf(planSplit(change, state, ["U4"]))).toMatch(/parked/);
	});

	test("a unit on the latest parked record cannot move after resume", () => {
		const parked = comment("parked", "parked.1", { waits_for: [34], units: [{ unit: "U4", lane: false, branch: "b" }], at: "t" }, 0);
		const resumed = comment("parked", "parked.2", { resumed: true, at: "t2" }, 1);
		const { change, state } = setup(UNITS, { marked: [parked, resumed] });
		expect(refusedOf(planSplit(change, state, ["U4"]))).toMatch(/U4.*parked/);
		expect("refused" in planSplit(change, state, ["U7"])).toBe(false);
	});

	test("a pending plan gate request refuses", () => {
		const pending = { id: "r1", subject: "gate:plan" as const, kind: "gate" as const, mode: "blocking" as const, createdAt: "", data: {} as never };
		const { change, state } = setup(UNITS, { requests: { pending: [pending], applying: [] } });
		expect(refusedOf(planSplit(change, state, ["U4"]))).toMatch(/gate:plan/);
	});
});

describe("planSplit plan", () => {
	test("dependsOnN is true when U5 depends on U2, which stays", () => {
		const { change, state } = setup();
		const plan = planOf(planSplit(change, state, ["U5", "U6"]));
		expect(plan.dependsOnN).toBe(true);
		expect(plan.moved.map((u) => u.id)).toEqual(["U5", "U6"]);
	});

	test("dependsOnN is false when moved units only depend on each other", () => {
		const { change, state } = setup(UNITS.map((u) => (u.id === "U5" ? { ...u, depends: [] } : u)));
		expect(planOf(planSplit(change, state, ["U5", "U6"])).dependsOnN).toBe(false);
	});

	test("Split brings the capability count within limits", () => {
		const { change, state } = setup();
		const plan = planOf(planSplit(change, state, ["U5", "U6"]));
		expect(plan.keptCapabilities).toEqual({ new: [], modified: ["rate-limit", "request-context", "audit-log"] });
		expect(plan.newCapabilities).toEqual({ new: [], modified: ["admin-ui"] });
		const kept = parseChange(plan.keptBody);
		expect(kept.units.map((u) => u.id)).toEqual(["U1", "U2", "U3", "U4", "U7"]);
		expect(kept.header.capabilities).toEqual(plan.keptCapabilities);
		expect(exceededLimits(changeSize(kept), { max_capabilities: 3 })).toEqual([]);
		expect(plan.keptBody).not.toMatch(/\n\n\n/);
	});

	test("a capability another unit still covers stays on #N too", () => {
		const { change, state } = setup();
		const plan = planOf(planSplit(change, state, ["U4"]));
		expect(plan.keptCapabilities.modified).toContain("rate-limit");
		expect(plan.newCapabilities).toEqual({ new: [], modified: ["rate-limit"] });
	});

	test("a capability #N declares new moves as new", () => {
		const { change, state } = setup(UNITS, {}, "new [admin-ui], modified [rate-limit, request-context, audit-log]");
		const plan = planOf(planSplit(change, state, ["U5", "U6"]));
		expect(plan.newCapabilities).toEqual({ new: ["admin-ui"], modified: [] });
		expect(plan.keptCapabilities).toEqual({ new: [], modified: ["rate-limit", "request-context", "audit-log"] });
	});

	test("writes nothing into state", () => {
		const { change, state } = setup();
		const before = JSON.stringify(change.lines);
		planSplit(change, state, ["U5", "U6"]);
		expect(JSON.stringify(change.lines)).toBe(before);
	});
});
