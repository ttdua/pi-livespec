import { describe, expect, test } from "vitest";
import type { DepState } from "../../src/engine/deps-facts.ts";
import type { Issue, Version } from "../../src/forge/types.ts";
import type { InitiativeDrafts } from "../../src/initiatives/drafts.ts";
import { type InitiativeInput, type PlanCtx, planInitiative } from "../../src/initiatives/propose.ts";
import { stateFor } from "../helpers/change-state.ts";

const SHAPE_BODY = "Depends: —\nCapabilities: new [], modified []\nProduct impact: —\n\n## Proposal\nCap requests.\n\n## Units\n";

function issue(number: number, title: string, body: string, o: { labels?: string[]; state?: "open" | "closed" } = {}): Issue {
	return { number, title, body, labels: o.labels ?? ["livespec"], state: o.state ?? "open", author: "a", updatedAt: "", version: "cv:1" as Version };
}

/** Change #20 `rate-limit` in shape, without an initiative. */
const shape20 = () => stateFor("shape", { issue: { number: 20, title: "rate-limit", labels: ["livespec", "livespec:phase/shape"], state: "open" } }, SHAPE_BODY);

const ctxOf = (o: Partial<PlanCtx> = {}): PlanCtx => ({ open: [], referenced: new Map(), ...o });

const input = (entries: InitiativeInput["entries"], o: Partial<InitiativeInput> = {}): InitiativeInput => ({ name: "limits", goal: "Limit requests", capabilities: ["rate-limit"], entries, ...o });

const entry = (name: string, depends: string[] = [], proposal = `Do ${name}.`) => ({ name, proposal, depends });

function refusedOf(out: ReturnType<typeof planInitiative>): string {
	if (!("refused" in out)) throw new Error(`expected a refusal, got drafts ${JSON.stringify(out.drafts)}`);
	return out.refused;
}

function draftsOf(out: ReturnType<typeof planInitiative>): InitiativeDrafts {
	if ("refused" in out) throw new Error(`refused: ${out.refused}`);
	return out.drafts;
}

describe("planInitiative: a new initiative", () => {
	test("drafts list the current change by number and new entries by name", () => {
		const out = planInitiative(input([entry("add-request-context"), entry("rate-limit", ["add-request-context"])]), shape20(), ctxOf());
		expect(draftsOf(out)).toEqual({
			name: "limits",
			goal: "Limit requests",
			capabilities: ["rate-limit"],
			current: 20,
			entries: [
				{ name: "add-request-context", proposal: "Do add-request-context.", depends: [] },
				{ name: "rate-limit", number: 20, proposal: "Do rate-limit.", depends: ["add-request-context"] },
			],
		});
	});

	test("Cycle refused", () => {
		const refused = refusedOf(planInitiative(input([entry("a", ["b"]), entry("b", ["a"]), entry("rate-limit")]), shape20(), ctxOf()));
		expect(refused).toContain("a → b → a");
	});

	test("Self dependency", () => {
		const refused = refusedOf(planInitiative(input([entry("a", ["a"]), entry("rate-limit")]), shape20(), ctxOf()));
		expect(refused).toContain("a → a");
	});

	test("an unknown Depends name is refused", () => {
		const refused = refusedOf(planInitiative(input([entry("rate-limit", ["nope"])]), shape20(), ctxOf()));
		expect(refused).toContain("nope");
	});

	test("a non-kebab name is refused", () => {
		expect(refusedOf(planInitiative(input([entry("Bad_Name"), entry("rate-limit")]), shape20(), ctxOf()))).toContain("Bad_Name");
		expect(refusedOf(planInitiative(input([entry("rate-limit")], { name: "Limits!" }), shape20(), ctxOf()))).toContain("Limits!");
	});

	test("an empty Proposal or one with a level-2 heading is refused", () => {
		expect(refusedOf(planInitiative(input([entry("a", [], " "), entry("rate-limit")]), shape20(), ctxOf()))).toContain("Proposal");
		expect(refusedOf(planInitiative(input([entry("a", [], "x\n## Design\ny"), entry("rate-limit")]), shape20(), ctxOf()))).toContain("heading");
	});

	test("foreign issue in Depends refused", () => {
		const foreign = new Map<number, Issue | "missing">([[99, issue(99, "bug", "", { labels: ["bug"] })]]);
		expect(refusedOf(planInitiative(input([entry("rate-limit", ["#99"])]), shape20(), ctxOf({ referenced: foreign })))).toContain("#99");
		const missing = new Map<number, Issue | "missing">([[99, "missing"]]);
		expect(refusedOf(planInitiative(input([entry("rate-limit", ["#99"])]), shape20(), ctxOf({ referenced: missing })))).toContain("#99");
	});

	test("closed merged dependency accepted", () => {
		const merged = new Map<number, Issue | "missing">([[12, issue(12, "old", "PR: #41\n", { state: "closed" })]]);
		const drafts = draftsOf(planInitiative(input([entry("rate-limit", ["#12"])]), shape20(), ctxOf({ referenced: merged })));
		expect(drafts.entries[0]?.depends).toEqual([12]);
	});

	test("a new entry's name clashing with an open issue is refused", () => {
		const open = [issue(33, "audit-log", "")];
		expect(refusedOf(planInitiative(input([entry("audit-log"), entry("rate-limit")]), shape20(), ctxOf({ open })))).toContain("#33");
	});

	test("no current entry, or two, is refused", () => {
		expect(refusedOf(planInitiative(input([entry("a")]), shape20(), ctxOf()))).toContain("rate-limit");
		expect(refusedOf(planInitiative(input([entry("rate-limit"), entry("rate-limit")]), shape20(), ctxOf()))).toContain("rate-limit");
	});

	test("outside shape without an Initiative line is refused", () => {
		const build = stateFor("build", { issue: { number: 20, title: "rate-limit", labels: ["livespec"], state: "open" } }, SHAPE_BODY);
		expect(refusedOf(planInitiative(input([entry("rate-limit")]), build, ctxOf()))).toContain("shape");
	});
});

// --- amendments: initiative #30 lists #34 and #35 -------------------------------------------------

const INITIATIVE_30 = "Goal: g\nCapabilities: [rate-limit]\n\n## Changes\n- [ ] #34 request-context — Depends: —\n- [ ] #35 rate-limit — Depends: #34\n";

const planned = (o: { branch?: boolean; units?: boolean; depends?: string } = {}) =>
	[
		"Initiative: #30",
		...(o.branch ? ["Branch: livespec/x"] : []),
		`Depends: ${o.depends ?? "—"}`,
		"Capabilities: new [], modified []",
		"",
		"## Proposal",
		"Old proposal.",
		"",
		"## Units",
		...(o.units ? ["### U1 — Thing", "Covers: a/Requirement: b", "- [ ] pending"] : []),
		"",
	].join("\n");

type AmendSetup = { b34?: string; b35?: string; s34?: DepState; closed34?: boolean };

function amendCtx(o: AmendSetup = {}): { state: ReturnType<typeof stateFor>; ctx: PlanCtx } {
	const b35 = o.b35 ?? planned({ depends: "#34" });
	const i34 = issue(34, "request-context", o.b34 ?? planned(), o.closed34 ? { state: "closed" } : {});
	const i35 = issue(35, "rate-limit", b35);
	const state = stateFor("build", { issue: { number: 35, title: "rate-limit", labels: ["livespec", "livespec:phase/build"], state: "open" } }, b35);
	const i30 = issue(30, "limits", INITIATIVE_30, { labels: ["livespec:initiative"] });
	const referenced = new Map<number, Issue | "missing">([[30, i30], [34, i34], [35, i35]]);
	const states = new Map<number, DepState>([[34, o.s34 ?? "open"], [35, "open"]]);
	return { state, ctx: { open: [i34, i35].filter((i) => i.state === "open"), referenced, states } };
}

describe("planInitiative: amendments", () => {
	test("New change added midway", () => {
		const { state, ctx } = amendCtx();
		const drafts = draftsOf(planInitiative(input([entry("audit-log", ["#35"])]), state, ctx));
		expect(drafts).toMatchObject({ amend: 30, current: 35, entries: [{ name: "audit-log", proposal: "Do audit-log.", depends: [35] }] });
	});

	test("removing an abandoned dependency and entry", () => {
		const { state, ctx } = amendCtx({ b35: planned({ branch: true, depends: "#34" }), s34: "abandoned", closed34: true });
		const drafts = draftsOf(planInitiative(input([], { remove: ["#35:#34", "#34"] }), state, ctx));
		expect(drafts.entries).toEqual([{ name: "rate-limit", number: 35, depends: [] }]);
		expect(drafts.remove).toEqual([34]);
	});

	test("removing a non-abandoned entry is refused", () => {
		const { state, ctx } = amendCtx();
		expect(refusedOf(planInitiative(input([], { remove: ["#34"] }), state, ctx))).toContain("#34");
	});

	test("removing a dependency that is not abandoned is refused on a started change", () => {
		const { state, ctx } = amendCtx({ b35: planned({ branch: true, depends: "#34" }) });
		expect(refusedOf(planInitiative(input([], { remove: ["#35:#34"] }), state, ctx))).toContain("#34");
	});

	test("Planned change cannot be re-proposed", () => {
		const { state, ctx } = amendCtx({ b34: planned({ units: true }) });
		const refused = refusedOf(planInitiative(input([entry("request-context", [], "New proposal.")]), state, ctx));
		expect(refused).toContain("request-context");
		expect(refused).toMatch(/change_split|unit_amend/);
	});

	test("the Proposal of an unplanned change may change", () => {
		const { state, ctx } = amendCtx();
		const drafts = draftsOf(planInitiative(input([entry("request-context", [], "New proposal.")]), state, ctx));
		expect(drafts.entries).toEqual([{ name: "request-context", number: 34, proposal: "New proposal." }]);
	});

	test("editing Depends of a change with Branch is refused", () => {
		const { state, ctx } = amendCtx({ b34: planned({ branch: true }) });
		const refused = refusedOf(planInitiative(input([entry("request-context", ["#35"], "")]), state, ctx));
		expect(refused).toContain("Branch");
	});

	test("Amendment cycle refused", () => {
		const { state, ctx } = amendCtx();
		const refused = refusedOf(planInitiative(input([entry("request-context", ["#35"], "")]), state, ctx));
		expect(refused).toContain("#34 → #35 → #34");
	});

	test("an amendment that changes nothing is refused", () => {
		const { state, ctx } = amendCtx();
		expect(refusedOf(planInitiative(input([entry("rate-limit", ["#34"], "")]), state, ctx))).toContain("nothing");
	});
});
