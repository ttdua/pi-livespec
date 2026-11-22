import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { parseInitiative } from "../../src/core/initiative.ts";
import { sectionText } from "../../src/core/sections.ts";
import { resetGatesForTests } from "../../src/engine/gates.ts";
import { filterMarked, type MarkedComment } from "../../src/forge/markers.ts";
import type { Forge, Issue, Version, WriteResult } from "../../src/forge/types.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { pollApprovals } from "../../src/interaction/poll.ts";
import { readRequests } from "../../src/interaction/requests.ts";
import { MAX_READS } from "../../src/initiatives/propose-read.ts";
import type { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import type { FakeUI, SelectFn } from "../hooks/fake-pi.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "./helpers.ts";
import { shipReady } from "./ship-fixture.ts";

afterEach(async () => {
	setSession(undefined);
	resetGatesForTests();
	await cleanupDirs();
});

const FORGE_CHAIN = "integrationBranch: main\ninteraction: { adapter: [forge] }\n";
const SHAPE_BODY = "Depends: —\nCapabilities: new [], modified []\nProduct impact: —\n\n## Proposal\nCap each IP.\n\n## Design\n\n## Questions\n\n## Units\n\n## Durable docs\n";

/** A scripted in-session human: the gate summary picks `pick`; follow-ups answer "no". */
function human(pick: string, input?: string): FakeUI {
	const select: SelectFn = async (title, options) => {
		if (title === "Add notes?") return "No notes";
		return options.find((o) => o === pick || o.endsWith(`[${pick}]`));
	};
	return { hasUI: true, select, ...(input !== undefined ? { input: async () => input } : {}) };
}

type Opts = { phase?: string; config?: string; ui?: FakeUI; forge?: (world: MemoryWorld) => Forge; body?: string };

/** Change `per-ip-cap` (the harness change) on its branch. */
const shape = (o: Opts = {}): Promise<ToolHarness> =>
	toolHarness({
		change: { body: o.body ?? SHAPE_BODY, phase: o.phase ?? "shape" },
		...(o.config ? { config: o.config } : {}),
		...(o.ui ? { ui: o.ui } : {}),
		...(o.forge ? { forge: o.forge } : {}),
	});

const twoEntries = {
	name: "limits",
	goal: "Limit requests",
	capabilities: ["rate-limit"],
	entries: [
		{ name: "add-request-context", proposal: "Read the client IP.", depends: [] },
		{ name: "per-ip-cap", proposal: "Cap each IP at 100 rps.", depends: ["add-request-context"] },
	],
};

async function marked(h: ToolHarness, n = h.n): Promise<MarkedComment[]> {
	return filterMarked(await h.world.forge.listComments(n), BOT_LOGIN).comments;
}
const ofKind = async (h: ToolHarness, kind: string) => (await marked(h)).filter((m) => m.kind === kind);
const all = (h: ToolHarness) => h.world.forge.searchIssues({ state: "all" });
const titled = async (h: ToolHarness, title: string) => (await all(h)).filter((i) => i.title === title);
const trackingIssues = async (h: ToolHarness) => (await all(h)).filter((i) => i.labels.includes("livespec:initiative"));

async function oneTracking(h: ToolHarness): Promise<Issue> {
	const t = await trackingIssues(h);
	expect(t).toHaveLength(1);
	return t[0] as Issue;
}

/** Answers the pending request on the forge as `alice` and polls. */
async function forgeApprove(h: ToolHarness, command = "/livespec approve"): Promise<void> {
	await h.world.setPermission("alice", "write");
	await h.world.postComment(h.n, "alice", command);
	await pollApprovals(h.session);
}

describe("initiative_propose: the request", () => {
	test("Proposal sent", async () => {
		const h = await shape({ config: FORGE_CHAIN });
		const before = (await all(h)).length;
		const out = await h.call("initiative_propose", twoEntries);
		expect(out.isError, textOf(out)).toBe(false);
		const requests = await ofKind(h, "request");
		expect(requests).toHaveLength(1);
		const data = requests[0]?.data as { subject: string; summary: string; snapshot: { drafts: { entries: { name: string }[] } } };
		expect(data.subject).toBe("gate:initiative");
		expect(data.summary).toContain("add-request-context");
		expect(data.summary).toContain("per-ip-cap");
		expect(data.summary).toContain("Depends: add-request-context");
		expect(data.snapshot.drafts.entries.map((e) => e.name)).toEqual(["add-request-context", "per-ip-cap"]);
		expect((await all(h)).length).toBe(before);
	});

	test("Bare spec_gate refused", async () => {
		const h = await shape({ config: FORGE_CHAIN });
		const out = await h.call("spec_gate", { target: "initiative" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("initiative_propose");
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("refused outside shape when the change has no Initiative", async () => {
		const h = await shape({ phase: "define", config: FORGE_CHAIN });
		const out = await h.call("initiative_propose", twoEntries);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("shape");
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("Cycle refused", async () => {
		const h = await shape({ config: FORGE_CHAIN });
		const entries = [
			{ name: "a", proposal: "A.", depends: ["b"] },
			{ name: "b", proposal: "B.", depends: ["a"] },
			{ name: "per-ip-cap", proposal: "Cap.", depends: [] },
		];
		const out = await h.call("initiative_propose", { ...twoEntries, entries });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("a → b → a");
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("Self dependency", async () => {
		const h = await shape({ config: FORGE_CHAIN });
		const out = await h.call("initiative_propose", { ...twoEntries, entries: [{ name: "per-ip-cap", proposal: "Cap.", depends: ["per-ip-cap"] }] });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(`#${h.n} → #${h.n}`);
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("Initiative name taken", async () => {
		const h = await shape({ config: FORGE_CHAIN });
		const taken = await h.world.seedIssue({ title: "limits", body: "Goal: other\n\n## Changes\n", labels: ["livespec:initiative"] });
		const out = await h.call("initiative_propose", twoEntries);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(`#${taken}`);
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("too many dependencies to check is refused", async () => {
		const h = await shape({ config: FORGE_CHAIN });
		let prev = await h.world.seedIssue({ title: "c0", body: "Depends: —\n", labels: ["livespec"] });
		for (let i = 1; i <= MAX_READS; i++) prev = await h.world.seedIssue({ title: `c${i}`, body: `Depends: #${prev}\n`, labels: ["livespec"] });
		const out = await h.call("initiative_propose", { ...twoEntries, entries: [{ name: "per-ip-cap", proposal: "Cap.", depends: [`#${prev}`] }] });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("too many dependencies");
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("a foreign issue in Depends is refused", async () => {
		const h = await shape({ config: FORGE_CHAIN });
		const foreign = await h.world.seedIssue({ title: "bug", labels: ["bug"] });
		const out = await h.call("initiative_propose", { ...twoEntries, entries: [{ name: "per-ip-cap", proposal: "Cap.", depends: [`#${foreign}`, "#999"] }] });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(`#${foreign}`);
		expect(await ofKind(h, "request")).toEqual([]);
	});
});

describe("initiative gate completion", () => {
	test("Approval creates everything at once", async () => {
		const h = await shape({ ui: human("approve") });
		const out = await h.call("initiative_propose", twoEntries);
		expect(out.isError, textOf(out)).toBe(false);
		const t = await oneTracking(h);
		expect(t.title).toBe("limits");
		const [a] = await titled(h, "add-request-context");
		expect(a?.labels).toEqual(["livespec", "livespec:phase/shape"]);
		const ac = parseChange(a?.body ?? "");
		expect(ac.header.initiative).toBe(`#${t.number}`);
		expect(ac.header.depends).toEqual([]);
		expect(sectionText(a?.body ?? "", "Proposal")).toBe("Read the client IP.");
		expect(t.body).toContain("Goal: Limit requests");
		expect(parseInitiative(t.body).changes.map((c) => [c.number, c.name, c.depends])).toEqual([
			[a?.number, "add-request-context", []],
			[h.n, "per-ip-cap", [a?.number]],
		]);
		expect(t.body).toContain(`- [ ] #${a?.number} add-request-context — Depends: —`);
		const current = await h.world.bodyOf(h.n);
		expect(parseChange(current).header).toMatchObject({ initiative: `#${t.number}`, depends: [`#${a?.number}`] });
		expect(sectionText(current, "Proposal")).toBe("Cap each IP at 100 rps.");
		expect((await ofKind(h, "gate"))[0]?.data).toMatchObject({ gate: "initiative", outcome: "approved" });
	});

	test("Changes requested", async () => {
		const h = await shape({ ui: human("request changes", "fewer changes") });
		const before = (await all(h)).length;
		await h.call("initiative_propose", twoEntries);
		expect((await all(h)).length).toBe(before);
		expect((await ofKind(h, "gate"))[0]?.data).toMatchObject({ outcome: "changes_requested" });
		expect((await h.world.forge.getIssue(h.n)).labels).toContain("livespec:phase/shape");
		expect(parseChange(await h.world.bodyOf(h.n)).header.initiative).toBeUndefined();
	});

	test("Retry after a crash", async () => {
		let creates = 0;
		const crashing = (world: MemoryWorld): Forge =>
			new Proxy(world.forge, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (prop !== "createIssue" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
					return async (...args: unknown[]) => {
						creates++;
						const created = await value.apply(target, args);
						if (creates === 2) throw new Error("injected crash after the second createIssue");
						return created;
					};
				},
			});
		const h = await shape({ config: FORGE_CHAIN, forge: crashing });
		await h.call("initiative_propose", twoEntries);
		await forgeApprove(h);
		expect(await ofKind(h, "gate")).toEqual([]);
		expect(readRequests(await marked(h)).applying).toHaveLength(1);
		await pollApprovals(h.session);
		expect(await trackingIssues(h)).toHaveLength(1);
		expect(await titled(h, "add-request-context")).toHaveLength(1);
		expect(await ofKind(h, "gate")).toHaveLength(1);
		expect(parseInitiative((await oneTracking(h)).body).changes).toHaveLength(2);
		expect(parseChange(await h.world.bodyOf(h.n)).header.initiative).toBeDefined();
	});

	test("conflict on the changes list retries", async () => {
		let conflicted = false;
		const conflicting = (world: MemoryWorld): Forge =>
			new Proxy(world.forge, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (prop !== "updateIssueBody" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
					return async (n: number, body: string, expect: Version): Promise<WriteResult<Issue>> => {
						if (!conflicted && body.includes("## Changes")) {
							conflicted = true;
							return { status: "conflict", current: expect, changed: ["body"] };
						}
						return value.call(target, n, body, expect);
					};
				},
			});
		const h = await shape({ config: FORGE_CHAIN, forge: conflicting });
		await h.call("initiative_propose", twoEntries);
		await forgeApprove(h);
		expect(conflicted).toBe(true);
		expect(await ofKind(h, "gate")).toEqual([]);
		await pollApprovals(h.session);
		expect(await trackingIssues(h)).toHaveLength(1);
		expect(await titled(h, "add-request-context")).toHaveLength(1);
		expect(parseInitiative((await oneTracking(h)).body).changes).toHaveLength(2);
		expect(await ofKind(h, "gate")).toHaveLength(1);
	});

	test("an approval is superseded when another initiative took the name meanwhile", async () => {
		const h = await shape({ config: FORGE_CHAIN });
		await h.call("initiative_propose", twoEntries);
		const other = await h.world.seedIssue({ title: "limits", body: "Goal: other\nCapabilities: []\n\n## Changes\n- [ ] #77 elsewhere — Depends: —\n", labels: ["livespec:initiative"] });
		await forgeApprove(h);
		const gate = (await ofKind(h, "gate"))[0]?.data as { superseded?: boolean };
		expect(gate.superseded).toBe(true);
		expect((await ofKind(h, "answer"))[0]?.data).toMatchObject({ verdict: "superseded", reason: expect.stringContaining(`#${other}`) });
		expect(await trackingIssues(h)).toHaveLength(1);
		expect(await titled(h, "add-request-context")).toEqual([]);
		expect(await h.world.bodyOf(other)).not.toContain("add-request-context");
	});

	test("an approval is superseded when a new name was taken meanwhile", async () => {
		const h = await shape({ config: FORGE_CHAIN });
		await h.call("initiative_propose", twoEntries);
		await h.world.seedIssue({ title: "add-request-context", labels: ["livespec", "livespec:phase/shape"] });
		await forgeApprove(h);
		expect((await ofKind(h, "gate"))[0]?.data).toMatchObject({ superseded: true });
		expect(await trackingIssues(h)).toEqual([]);
	});
});

// --- amendments ----------------------------------------------------------------------------------

const trackingBody = (entries: string[]) => ["Goal: Limit requests", "Capabilities: [rate-limit]", "", "## Changes", ...entries, ""].join("\n");

/** The harness change in initiative T with `depends`, beside `others` (seeded before T). */
async function inInitiative(h: ToolHarness, o: { depends?: number[]; entries: (n: number) => string[] }): Promise<number> {
	const t = await h.world.seedIssue({ title: "limits", body: trackingBody(o.entries(h.n)), labels: ["livespec:initiative"] });
	const deps = o.depends ?? [];
	const body = (await h.world.bodyOf(h.n)).replace(/^Depends: .*$/m, `Initiative: #${t}\nDepends: ${deps.length === 0 ? "—" : deps.map((d) => `#${d}`).join(", ")}`);
	await h.world.editBodyBehindBack(h.n, body);
	await h.session.refresh();
	return t;
}

describe("initiative amendments", () => {
	test("New change added midway", async () => {
		const h = await shape({ phase: "build", ui: human("approve") });
		const t = await inInitiative(h, { entries: (n) => [`- [ ] #${n} per-ip-cap — Depends: —`] });
		const out = await h.call("initiative_propose", { name: "limits", goal: "", capabilities: [], entries: [{ name: "audit-log", proposal: "Log decisions.", depends: [`#${h.n}`] }] });
		expect(out.isError, textOf(out)).toBe(false);
		const [audit] = await titled(h, "audit-log");
		expect(parseChange(audit?.body ?? "").header).toMatchObject({ initiative: `#${t}`, depends: [`#${h.n}`] });
		expect(audit?.labels).toContain("livespec:phase/shape");
		expect(parseInitiative(await h.world.bodyOf(t)).changes.map((c) => c.name)).toEqual(["per-ip-cap", "audit-log"]);
		expect(await trackingIssues(h)).toHaveLength(1);
	});

	test("Abandoned dependency removed from a started change", async () => {
		const h = await shape({ phase: "build", ui: human("approve") });
		const dep = await h.world.seedIssue({ title: "request-context", body: "Depends: —\n", labels: ["livespec"], state: "closed" });
		const t = await inInitiative(h, { depends: [dep], entries: (n) => [`- [ ] #${dep} request-context — Depends: —`, `- [ ] #${n} per-ip-cap — Depends: #${dep}`] });
		const out = await h.call("initiative_propose", { name: "limits", goal: "", capabilities: [], entries: [], remove: [`#${h.n}:#${dep}`, `#${dep}`] });
		expect(out.isError, textOf(out)).toBe(false);
		expect(parseChange(await h.world.bodyOf(h.n)).header.depends).toEqual([]);
		expect(await h.world.bodyOf(h.n)).toMatch(/^Depends: —$/m);
		const changes = parseInitiative(await h.world.bodyOf(t)).changes;
		expect(changes.map((c) => [c.number, c.depends])).toEqual([[h.n, []]]);
	});

	test("Amendment cycle refused", async () => {
		const h = await shape({ phase: "build", config: FORGE_CHAIN });
		const other = await h.world.seedIssue({ title: "request-context", body: `Depends: #${h.n}\n`, labels: ["livespec", "livespec:phase/shape"] });
		await inInitiative(h, { depends: [other], entries: (n) => [`- [ ] #${other} request-context — Depends: —`, `- [ ] #${n} per-ip-cap — Depends: #${other}`] });
		const out = await h.call("initiative_propose", { name: "limits", goal: "", capabilities: [], entries: [{ name: "audit-log", proposal: "Log.", depends: [`#${h.n}`] }] });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("→");
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("Initiative closes after an abandoned entry is removed", async () => {
		const h = await shipReady({ noShipGate: true, ui: human("approve") });
		const dep = await h.world.seedIssue({ title: "request-context", body: "Depends: —\n", labels: ["livespec"], state: "closed" });
		const t = await inInitiative(h, { depends: [dep], entries: (n) => [`- [ ] #${dep} request-context — Depends: —`, `- [ ] #${n} per-ip-cap — Depends: #${dep}`] });
		const proposed = await h.call("initiative_propose", { name: "limits", goal: "", capabilities: [], entries: [], remove: [`#${h.n}:#${dep}`, `#${dep}`] });
		expect(proposed.isError, textOf(proposed)).toBe(false);
		const pr = await h.world.seedPullRequest({ head: "livespec/per-ip-cap", state: "closed", merged: true });
		await h.world.editBodyBehindBack(h.n, (await h.world.bodyOf(h.n)).replace(/^Branch:/m, `PR: #${pr}\nBranch:`));
		await h.world.dropLabel("livespec:phase/ship");
		await h.world.forge.addLabels(h.n, ["livespec:phase/close"]);
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		const out = await h.call("change_close", {});
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(parseInitiative(await h.world.bodyOf(t)).changes.map((c) => [c.number, c.checked])).toEqual([[h.n, true]]);
		expect((await h.world.forge.getIssue(t)).state).toBe("closed");
		const emitted = (h.pi.api.events.emit as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0]);
		expect(emitted).toContain("livespec:initiative-closed");
	});
});
