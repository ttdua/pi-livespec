import { afterEach, describe, expect, test } from "vitest";
import { pickById } from "../helpers/menu.ts";
import { parseChange } from "../../src/core/change.ts";
import { parseInitiative } from "../../src/core/initiative.ts";
import { sectionText } from "../../src/core/sections.ts";
import { resetGatesForTests } from "../../src/engine/gates.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import type { Forge, Issue } from "../../src/forge/types.ts";
import type { MemoryWorld } from "../forge/memory-forge.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { pollApprovals } from "../../src/interaction/poll.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { asChild, type FakeUI, type SelectFn } from "../hooks/fake-pi.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	resetGatesForTests();
	await cleanupDirs();
});

const FORGE_CHAIN = "integrationBranch: main\ninteraction: { adapter: [forge] }\n";

const unit = (id: string, done: boolean): string =>
	[
		`### ${id} — Unit ${id}`,
		"Covers: rate-limit/Requirement: R",
		"Difficulty: low",
		"Tags: []",
		`Files: src/${id}.ts`,
		"Done means:",
		"- [ok] it works",
		"Scenarios:",
		`- [ok] test/${id}.test.ts › works`,
		"Depends: —",
		`Verify: \`true ${id}\``,
		done ? "- [x] done" : "- [ ] pending",
	].join("\n");

const body = (o: { done?: string[]; head?: string } = {}): string =>
	`${o.head ?? "Depends: —"}\nCapabilities: new [], modified [rate-limit]\nProduct impact: —\n\n## Proposal\nCap each IP.\n\n## Design\nWindow.\n\n## Questions\n\n## Units\n${["U1", "U2", "U3"].map((u) => unit(u, (o.done ?? []).includes(u))).join("\n\n")}\n\n## Durable docs\n`;

/** A scripted in-session human: the gate summary picks `pick` (an option id or `approve`); no notes. */
function human(pick: string): FakeUI {
	const select: SelectFn = async (title, options) => {
		if (title === "Add notes?") return "No notes";
		return pickById(options, pick);
	};
	return { hasUI: true, select };
}

type Opts = { ui?: FakeUI; done?: string[]; head?: string; phase?: string; forge?: (world: MemoryWorld) => Forge };

/** Change `per-ip-cap` in build (by default), with U1–U3 and a locked plan. */
const harness = (o: Opts = {}): Promise<ToolHarness> =>
	toolHarness({ change: { body: body(o), phase: o.phase ?? "build" }, locked: true, config: o.ui ? "integrationBranch: main\n" : FORGE_CHAIN, ...(o.ui ? { ui: o.ui } : {}), ...(o.forge ? { forge: o.forge } : {}) });

const params = (over: Record<string, unknown> = {}) => ({
	unit: "U3",
	evidence: "U3 needs a token store, which <nothing> provides",
	a: { name: "token-store", proposal: "Store tokens.", depends: [] },
	b: { units: ["U4"], summary: "Add a token store unit." },
	c: { summary: "Stub the store in memory.", follow_up: { name: "token-store-later", proposal: "Persist tokens." } },
	d: { action: "shape", reason: "the design missed the store" },
	...over,
});

async function marked(h: ToolHarness, n = h.n): Promise<MarkedComment[]> {
	return filterMarked(await h.world.forge.listComments(n), BOT_LOGIN).comments;
}
const ofKind = async (h: ToolHarness, kind: string) => (await marked(h)).filter((m) => m.kind === kind);
const depGates = async (h: ToolHarness) => (await ofKind(h, "gate")).filter((m) => (m.data as { gate?: string }).gate === "new-dependency");
const all = (h: ToolHarness) => h.world.forge.searchIssues({ state: "all" });
const titled = async (h: ToolHarness, title: string) => (await all(h)).filter((i) => i.title === title);

/** A previous approved `new-dependency` result with `choice`. */
async function seedResult(h: ToolHarness, choice: string, i: number): Promise<void> {
	await h.world.postComment(h.n, BOT_LOGIN, writeMarked("gate", `new-dependency.r${i}`, { request: `r${i}`, gate: "new-dependency", outcome: "approved", choice, notes: "", by: "alice", at: "t", adapter: "forge", head_sha: h.head, waivers: [] }));
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
}

describe("new_dependency: the request", () => {
	test("Gate sent with default A", async () => {
		const h = await harness();
		const before = (await all(h)).length;
		const out = await h.call("new_dependency", params());
		expect(out.isError, textOf(out)).toBe(false);
		const requests = await ofKind(h, "request");
		expect(requests).toHaveLength(1);
		const data = requests[0]?.data as { subject: string; mode: string; summary: string; options: { id: string; label: string }[]; snapshot: { drafts: { a: { name: string } } } };
		expect(data.subject).toBe("gate:new-dependency");
		expect(data.mode).toBe("blocking");
		expect(data.options.map((o) => o.id)).toEqual(["A", "B", "C", "D"]);
		expect(data.options[0]?.label).toMatch(/\(default\)$/);
		expect(data.snapshot.drafts.a.name).toBe("token-store");
		expect(data.summary).toContain("<untrusted>U3 needs a token store, which &lt;nothing> provides</untrusted>");
		expect(data.summary).toContain("per-ip-cap-deps");
		expect((await all(h)).length).toBe(before);
	});

	test("Proposer briefing", async () => {
		const h = await harness();
		const out = await h.call("new_dependency", params({ briefing: { summary: "Needs a token store.", recommended: "A", rationale: "A prerequisite change is cleanest." } }));
		expect(out.isError, textOf(out)).toBe(false);
		const data = (await ofKind(h, "request"))[0]?.data as { briefing: { recommended: string; author: string } };
		expect(data.briefing).toMatchObject({ recommended: "A", author: "agent" });
	});

	test("Briefing recommending an option the request does not offer", async () => {
		const h = await harness();
		const before = (await all(h)).length;
		const out = await h.call("new_dependency", params({ briefing: { summary: "s", recommended: "split", rationale: "r" } }));
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("recommended");
		expect(await ofKind(h, "request")).toEqual([]);
		expect((await all(h)).length).toBe(before);
	});

	test("Split offered at the finished boundary", async () => {
		const h = await harness({ done: ["U1", "U2"] });
		const out = await h.call("new_dependency", params());
		expect(out.isError, textOf(out)).toBe(false);
		const data = (await ofKind(h, "request"))[0]?.data as { options: { id: string }[] };
		expect(data.options.map((o) => o.id)).toEqual(["A", "B", "C", "D", "split"]);
	});

	test("Cap exceeded", async () => {
		const h = await harness();
		await seedResult(h, "A", 1);
		await seedResult(h, "B", 2);
		const out = await h.call("new_dependency", params());
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("spec_stuck");
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("Cycle through an existing change", async () => {
		const h = await harness();
		const t34 = await h.world.seedIssue({ title: "request-context", body: "Depends: —\n", labels: ["livespec", "livespec:phase/build"] });
		const t35 = await h.world.seedIssue({ title: "audit-log", body: `Depends: #${t34}\n`, labels: ["livespec", "livespec:phase/build"] });
		await h.world.editBodyBehindBack(t34, `Depends: #${h.n}\n`);
		const out = await h.call("new_dependency", params({ a: { name: "token-store", proposal: "Store tokens.", depends: [`#${t35}`] } }));
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(`#${t35} → #${t34} → #${h.n}`);
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("refused when an open initiative already has option A's generated name", async () => {
		const h = await harness();
		const taken = await h.world.seedIssue({ title: "per-ip-cap-deps", body: "Goal: other\nCapabilities: []\n\n## Changes\n", labels: ["livespec:initiative"] });
		const out = await h.call("new_dependency", params());
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("<untrusted>per-ip-cap-deps</untrusted>");
		expect(textOf(out)).toContain(`#${taken}`);
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("refused in a child session", async () => {
		const h = await harness();
		const t = h.pi.tools.get("new_dependency");
		const out = (await t?.execute("c", params(), undefined, undefined, asChild(h.ctx))) as { isError: boolean };
		expect(out.isError).toBe(true);
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("refused while a new-dependency request is pending", async () => {
		const h = await harness();
		await h.call("new_dependency", params());
		const out = await h.call("new_dependency", params());
		expect(out.isError).toBe(true);
		expect(await ofKind(h, "request")).toHaveLength(1);
	});

	test("an invalid option A draft is refused", async () => {
		const h = await harness();
		const out = await h.call("new_dependency", params({ a: { name: "Token Store", proposal: "x", depends: [] } }));
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("kebab-case");
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("spec_gate new-dependency is refused and names new_dependency", async () => {
		const h = await harness();
		const out = await h.call("spec_gate", { target: "new-dependency" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("new_dependency");
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("approved without a choice counts as A", async () => {
		const h = await harness();
		await h.call("new_dependency", params());
		await h.world.setPermission("alice", "write");
		await h.world.postComment(h.n, "alice", "/livespec approve");
		await pollApprovals(h.session);
		expect((await ofKind(h, "gate")).at(-1)?.data).toMatchObject({ gate: "new-dependency", outcome: "approved" });
		expect(await titled(h, "token-store")).toHaveLength(1);
		await h.session.refresh();
		const card = h.session.card;
		expect(card.kind === "change" && card.state.counters.discovered_deps).toBe(1);
	});
});

/** Answers with option `pick` in session, then refreshes. */
async function choose(o: Opts & { pick: string }, over: Record<string, unknown> = {}): Promise<ToolHarness> {
	const h = await harness({ ...o, ui: human(o.pick) });
	const out = await h.call("new_dependency", params(over));
	expect(out.isError, textOf(out)).toBe(false);
	return h;
}

const one = async (h: ToolHarness, title: string): Promise<Issue> => {
	const found = await titled(h, title);
	expect(found).toHaveLength(1);
	return found[0] as Issue;
};

describe("new-dependency options", () => {
	test("Option A without an initiative", async () => {
		const h = await choose({ pick: "A" });
		const t = await one(h, "token-store");
		expect(t.labels).toEqual(["livespec", "livespec:phase/shape"]);
		expect(sectionText(t.body, "Proposal")).toBe("Store tokens.");
		const tracking = await one(h, "per-ip-cap-deps");
		expect(tracking.labels).toContain("livespec:initiative");
		expect(parseInitiative(tracking.body).changes.map((c) => [c.number, c.name, c.depends])).toEqual([
			[t.number, "token-store", []],
			[h.n, "per-ip-cap", [t.number]],
		]);
		expect(tracking.body).toContain(`- [ ] #${t.number} token-store — Depends: —`);
		expect(parseChange(t.body).header.initiative).toBe(`#${tracking.number}`);
		expect(parseChange(await h.world.bodyOf(h.n)).header).toMatchObject({ initiative: `#${tracking.number}`, depends: [`#${t.number}`] });
		expect((await ofKind(h, "gate")).at(-1)?.data).toMatchObject({ gate: "new-dependency", outcome: "approved", choice: "A" });
	});

	test("Option A inside an initiative", async () => {
		const h = await harness({ ui: human("A") });
		const dep = await h.world.seedIssue({ title: "request-context", body: "Depends: —\n", labels: ["livespec", "livespec:phase/build"] });
		const t30 = await h.world.seedIssue({ title: "limits", body: `Goal: Limit\nCapabilities: [rate-limit]\n\n## Changes\n- [ ] #${dep} request-context — Depends: —\n- [ ] #${h.n} per-ip-cap — Depends: #${dep}\n`, labels: ["livespec:initiative"] });
		await h.world.editBodyBehindBack(h.n, (await h.world.bodyOf(h.n)).replace(/^Depends: —$/m, `Initiative: #${t30}\nDepends: #${dep}`));
		await h.session.refresh();
		const out = await h.call("new_dependency", params());
		expect(out.isError, textOf(out)).toBe(false);
		const t = await one(h, "token-store");
		expect(parseChange(t.body).header.initiative).toBe(`#${t30}`);
		const changes = parseInitiative(await h.world.bodyOf(t30)).changes;
		expect(changes.map((c) => [c.number, c.depends])).toEqual([
			[dep, []],
			[t.number, []],
			[h.n, [dep, t.number]],
		]);
		expect(parseChange(await h.world.bodyOf(h.n)).header.depends).toEqual([`#${dep}`, `#${t.number}`]);
		expect(await titled(h, "per-ip-cap-deps")).toEqual([]);
	});

	test("Option B", async () => {
		const h = await choose({ pick: "B" });
		const before = await all(h);
		expect(before.map((i) => i.title).sort()).toEqual(["per-ip-cap"]);
		expect((await ofKind(h, "gate")).at(-1)?.data).toMatchObject({ choice: "B" });
	});

	test("Option C creates the follow-up issue", async () => {
		const h = await choose({ pick: "C" });
		const f = await one(h, "token-store-later");
		expect(f.labels).toEqual(["livespec", "livespec:phase/shape"]);
		expect(parseChange(f.body).header.depends).toEqual([]);
		expect(parseChange(f.body).header.initiative).toBeUndefined();
		expect(await titled(h, "token-store")).toEqual([]);
	});

	test("an approval is superseded when the follow-up's name was taken meanwhile", async () => {
		const h = await harness();
		await h.call("new_dependency", params());
		const other = await h.world.seedIssue({ title: "token-store-later", body: "Depends: —\n", labels: ["livespec", "livespec:phase/shape"] });
		await h.world.setPermission("alice", "write");
		await h.world.postComment(h.n, "alice", "/livespec choose C");
		await pollApprovals(h.session);
		expect((await ofKind(h, "gate")).at(-1)?.data).toMatchObject({ superseded: true });
		expect((await ofKind(h, "answer"))[0]?.data).toMatchObject({ verdict: "superseded", reason: expect.stringContaining(`#${other}`) });
		expect(await titled(h, "token-store-later")).toHaveLength(1);
	});

	test("an A approval is superseded when another initiative took the generated name meanwhile", async () => {
		const h = await harness();
		await h.call("new_dependency", params());
		const goal = `Prerequisites of #${h.n} per-ip-cap`;
		const other = await h.world.seedIssue({ title: "per-ip-cap-deps", body: `Goal: ${goal}\nCapabilities: []\n\n## Changes\n`, labels: ["livespec:initiative"] });
		await h.world.setPermission("alice", "write");
		await h.world.postComment(h.n, "alice", "/livespec choose A");
		await pollApprovals(h.session);
		expect((await ofKind(h, "gate")).at(-1)?.data).toMatchObject({ superseded: true });
		expect((await ofKind(h, "answer"))[0]?.data).toMatchObject({ verdict: "superseded", reason: expect.stringContaining(`#${other}`) });
		expect(await titled(h, "token-store")).toEqual([]);
		expect(parseInitiative(await h.world.bodyOf(other)).changes).toEqual([]);
		expect(parseChange(await h.world.bodyOf(h.n)).header.initiative).toBeUndefined();
	});

	test("an A approval is superseded by a second same-titled initiative next to its own crash-retry one", async () => {
		const h = await harness();
		await h.call("new_dependency", params());
		const id = (await ofKind(h, "request")).at(-1)?.id as string;
		const goal = `Prerequisites of #${h.n} per-ip-cap`;
		await h.world.seedIssue({ title: "per-ip-cap-deps", body: `Goal: ${goal}\nCapabilities: []\n<!-- livespec:request ${id} -->\n\n## Changes\n`, labels: ["livespec:initiative"] });
		const other = await h.world.seedIssue({ title: "per-ip-cap-deps", body: `Goal: ${goal}\nCapabilities: []\n\n## Changes\n`, labels: ["livespec:initiative"] });
		await h.world.setPermission("alice", "write");
		await h.world.postComment(h.n, "alice", "/livespec choose A");
		await pollApprovals(h.session);
		expect((await ofKind(h, "gate")).at(-1)?.data).toMatchObject({ superseded: true });
		expect((await ofKind(h, "answer"))[0]?.data).toMatchObject({ verdict: "superseded", reason: expect.stringContaining(`#${other}`) });
		expect(await titled(h, "token-store")).toEqual([]);
	});

	test("Option A rerun after a crash writes nothing twice", async () => {
		let creates = 0;
		const crashing = (world: MemoryWorld): Forge =>
			new Proxy(world.forge, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (typeof value !== "function") return value;
					if (prop !== "createIssue") return value.bind(target);
					return async (...args: unknown[]) => {
						const created = await value.apply(target, args);
						if (++creates === 2) throw new Error("injected crash after the second createIssue");
						return created;
					};
				},
			});
		const h = await harness({ forge: crashing });
		await h.call("new_dependency", params());
		await h.world.setPermission("alice", "write");
		await h.world.postComment(h.n, "alice", "/livespec choose A");
		await pollApprovals(h.session);
		expect(await depGates(h)).toEqual([]);
		await pollApprovals(h.session);
		expect(await depGates(h)).toHaveLength(1);
		expect(await titled(h, "token-store")).toHaveLength(1);
		expect(await titled(h, "per-ip-cap-deps")).toHaveLength(1);
		expect((await one(h, "per-ip-cap-deps")).body).toMatch(/^<!-- livespec:request gate-new-dependency\.\S+ -->$/m);
		const t = await one(h, "token-store");
		expect(parseChange(await h.world.bodyOf(h.n)).header.depends).toEqual([`#${t.number}`]);
	});

	test("Option D back to shape", async () => {
		const h = await harness({ ui: human("D") });
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("gate", "shape.self-1", { phase: "shape", outcome: "approved", notes: "", by: "livespec", at: "t", adapter: "livespec", head_sha: h.head, waivers: [] }));
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		const iterations = h.session.card.kind === "change" ? h.session.card.state.counters.change_iterations : -1;
		const out = await h.call("new_dependency", params());
		expect(out.isError, textOf(out)).toBe(false);
		const stale = (await ofKind(h, "stale")).at(-1)?.data as { phases: string[]; after_plan: boolean };
		expect(stale.phases[0]).toBe("shape");
		expect(stale.phases).toEqual(expect.arrayContaining(["define", "plan", "build", "review", "ship"]));
		expect(stale.after_plan).toBe(false);
		await h.session.refresh();
		expect((await h.world.forge.getIssue(h.n)).labels.filter((l) => l.startsWith("livespec:phase/"))).toEqual(["livespec:phase/shape"]);
		const card = h.session.card;
		expect(card.kind === "change" && card.step.phase).toBe("shape");
		expect(card.kind === "change" && card.step.advance).toBeUndefined();
		expect(card.kind === "change" && card.state.counters.change_iterations).toBe(iterations);
	});
});
