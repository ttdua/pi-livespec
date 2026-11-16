import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { decisionComment } from "../../src/decide/records.ts";
import { registerGate, resetGatesForTests } from "../../src/engine/gates.ts";
import { pollApprovals } from "../../src/interaction/poll.ts";
import { readRequests } from "../../src/interaction/requests.ts";
import { registerCheck } from "../../src/engine/registry.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { MEMORY_WEB_URL, type MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import type { FakeUI, SelectFn } from "../hooks/fake-pi.ts";
import { allDone, CHANGE_BRANCH, resumeBody } from "../hooks/helpers.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	resetGatesForTests();
	await cleanupDirs();
});

const SPEC = readFileSync(new URL("../fixtures/rate-limit.spec.md", import.meta.url), "utf8");
const AT = "2026-11-15T10:00:00.000Z";
const FORGE_CHAIN = "integrationBranch: main\ninteraction: { adapter: [forge] }\n";
const BOTH_CHAIN = "integrationBranch: main\ninteraction: { adapter: [in-session, forge] }\n";
const labels = (phase: string) => ["livespec", `livespec:phase/${phase}`];

type Opts = { config?: string; ui?: FakeUI; files?: Record<string, string>; forge?: (world: MemoryWorld) => Forge; edit?: (b: string) => string };
type Gate = ToolHarness & { n: number };

/**
 * A change on its branch whose `Base` is the commit before a valid spec commit, so every define
 * check passes and the tree is clean. The harness registers `spec_gate` with the change tools.
 */
async function change(phase: string, o: Opts = {}): Promise<Gate> {
	const h = await toolHarness({
		branch: CHANGE_BRANCH,
		...(o.config ? { config: o.config } : {}),
		...(o.ui ? { ui: o.ui } : {}),
		...(o.files ? { files: o.files } : {}),
		...(o.forge ? { forge: o.forge } : {}),
	});
	const base = h.git("rev-parse", "HEAD");
	await writeIn(h.root, "specs/rate-limit/spec.md", SPEC);
	commitAll(h.root, "spec");
	const body = (o.edit ?? ((b: string) => b))(resumeBody(base));
	const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: labels(phase) });
	await h.session.refresh();
	return { ...h, n };
}

/** Rule decision records for every unit, so `unit-classification` passes at the plan gate. */
async function seedClassification(h: Gate): Promise<void> {
	for (const u of parseChange(await h.world.bodyOf(h.n)).units) {
		const digest = unitDigest(u);
		await h.world.postComment(h.n, BOT_LOGIN, decisionComment({ point: "tags", subject: u.id, digest, source: "rule", outcome: u.tags, reason: "rule" }));
		await h.world.postComment(h.n, BOT_LOGIN, decisionComment({ point: "difficulty", subject: u.id, digest, source: "rule", outcome: u.difficulty, reason: "rule" }));
	}
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
}

async function marked(h: Gate): Promise<MarkedComment[]> {
	return filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
}

async function ofKind(h: Gate, kind: string): Promise<MarkedComment[]> {
	return (await marked(h)).filter((m) => m.kind === kind);
}

async function phaseLabels(h: Gate): Promise<string[]> {
	return (await h.world.forge.getIssue(h.n)).labels.filter((l) => l.startsWith("livespec:phase/"));
}

/** A scripted in-session human: the first select (the gate summary) picks `pick`; follow-ups answer "no". */
function human(pick: string | undefined, input?: string): FakeUI {
	const select: SelectFn = async (title, options) => {
		if (title === "Add notes?") return "No notes";
		if (title === "Adjust Difficulty or Tags?") return "Keep classification";
		if (pick === undefined) return undefined;
		return options.find((o) => o === pick || o.endsWith(`[${pick}]`));
	};
	return { hasUI: true, select, ...(input !== undefined ? { input: async () => input } : {}) };
}

/** A Proposal longer than the payload shows, so the payload cuts it and links the issue. */
const longProposal = (b: string): string => b.replace("Limit each client IP.", ["Limit each client IP.", "line 2", "line 3", "line 4", "line 5", "line 6"].join("\n"));

function issueUrl(h: Gate): string {
	return `${MEMORY_WEB_URL}/issues/${h.n}`;
}

function card(h: Gate) {
	const c = h.session.card;
	if (c.kind !== "change") throw new Error(`no change card: ${c.kind}`);
	return c;
}

function gateData(m: MarkedComment | undefined): Record<string, unknown> {
	return (m?.data ?? {}) as Record<string, unknown>;
}

/** Posts an own marked comment behind the session's back and drops the comments cache, as a fresh read would. */
async function seedMarked(h: Gate, body: string): Promise<void> {
	await h.world.postComment(h.n, BOT_LOGIN, body);
	await h.session.comments?.invalidate(h.n);
}

function seedGate(h: Gate, phase: string, id: string, extra: Record<string, unknown> = {}): Promise<void> {
	const data = { phase, outcome: "approved", notes: "", by: "alice", at: AT, adapter: "in-session", head_sha: h.head, waivers: [], ...extra };
	return seedMarked(h, writeMarked("gate", `${phase}.${id}`, data));
}

/** Registers a waivable `size-limits` check that always fails and adds it to the plan checks. */
const SIZE_LIMITS_FLOW = {
	".pi/livespec/flow.yaml": "extends: agent-skills\nphases:\n  - id: plan\n    checks: [units-format, done-maps-scenarios, unit-classification, size-limits]\n",
};
function registerSizeLimits(): void {
	registerCheck("size-limits", async () => [{ code: "size-limits", severity: "error", message: "U3 touches too many files" }], { waivable: true });
}

describe("spec_gate", () => {
	test("Self gate", async () => {
		const h = await change("shape");
		const out = await h.call("spec_gate", { target: "shape" });
		expect(out.isError).toBe(false);
		const gate = await ofKind(h, "gate");
		expect(gate).toHaveLength(1);
		expect(gate[0]?.id).toMatch(/^shape\.self-[0-9a-z]+$/);
		expect(gateData(gate[0])).toMatchObject({ phase: "shape", outcome: "approved", by: "livespec", adapter: "livespec", head_sha: h.git("rev-parse", "HEAD"), waivers: [] });
		expect(await phaseLabels(h)).toEqual(["livespec:phase/define"]);
	});

	test("self gate with a failing waivable check is refused", async () => {
		registerSizeLimits();
		const h = await change("plan", { files: { ".pi/livespec/flow.yaml": `${SIZE_LIMITS_FLOW[".pi/livespec/flow.yaml"]}    gate: self\n` } });
		await seedClassification(h);
		const out = await h.call("spec_gate", { target: "plan" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("size-limits");
		expect(await ofKind(h, "gate")).toEqual([]);
	});

	test("Registered gate", async () => {
		registerGate("new-dependency", { checks: [] });
		const h = await change("build", { ui: human("approve") });
		const out = await h.call("spec_gate", { target: "new-dependency" });
		expect(out.isError).toBe(false);
		const gate = await ofKind(h, "gate");
		expect(gate).toHaveLength(1);
		expect(gateData(gate[0])).toMatchObject({ gate: "new-dependency", outcome: "approved", adapter: "in-session" });
		expect(gateData(gate[0]).phase).toBeUndefined();
		expect(await phaseLabels(h)).toEqual(["livespec:phase/build"]);
	});

	test("Define approved", async () => {
		const h = await change("define", { ui: human("approve"), edit: longProposal });
		const out = await h.call("spec_gate", { target: "define" });
		expect(out.isError).toBe(false);
		const gate = await ofKind(h, "gate");
		expect(gateData(gate[0])).toMatchObject({ phase: "define", outcome: "approved", adapter: "in-session" });
		expect(gateData(gate[0]).superseded).toBeUndefined();
		expect(await phaseLabels(h)).toEqual(["livespec:phase/plan"]);
		// The dialog showed the define review payload.
		const summary = h.ctx.ui.select.mock.calls[0]?.[0] ?? "";
		expect(summary).toContain("Capabilities: new [], modified [rate-limit]");
		expect(summary).toContain("specs/rate-limit/spec.md");
		expect(summary).toContain(`…\nFull text: ${issueUrl(h)}`);
	});

	test("forge define request links the issue for a truncated Proposal", async () => {
		const h = await change("define", { config: FORGE_CHAIN, edit: longProposal });
		await h.call("spec_gate", { target: "define" });
		const request = (await ofKind(h, "request"))[0];
		const text = await h.world.commentBodyOf(request?.commentId ?? "?");
		expect(text).toContain(`…\nFull text: ${issueUrl(h)}`);
		expect(text).toContain(`Links:\n- ${issueUrl(h)}`);
	});

	test("Relayed approval refused", async () => {
		const h = await change("plan", { ui: human(undefined) });
		await seedClassification(h);
		const out = await h.call("spec_gate", { target: "plan" });
		expect(out.isError).toBe(false);
		expect(gateData((await ofKind(h, "gate"))[0])).toMatchObject({ phase: "plan", outcome: "dismissed" });
		expect(await phaseLabels(h)).toEqual(["livespec:phase/plan"]);
	});

	test("extra outcome parameter is ignored", async () => {
		const h = await change("define", { ui: human(undefined) });
		const tool = h.pi.tools.get("spec_gate");
		expect(Object.keys((tool?.parameters as { properties: object }).properties)).toEqual(["target"]);
		const out = await h.call("spec_gate", { target: "define", outcome: "approved", choice: "waive", answer: "yes" });
		expect(out.isError).toBe(false);
		expect(gateData((await ofKind(h, "gate"))[0])).toMatchObject({ outcome: "dismissed", adapter: "in-session" });
		expect(await phaseLabels(h)).toEqual(["livespec:phase/define"]);
	});

	test("Unavailable without UI", async () => {
		const h = await change("define", { config: BOTH_CHAIN });
		const out = await h.call("spec_gate", { target: "define" });
		expect(out.isError).toBe(false);
		expect(h.ctx.ui.select).not.toHaveBeenCalled();
		const requests = await ofKind(h, "request");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.data).toMatchObject({ kind: "gate", subject: "gate:define", head_sha: h.git("rev-parse", "HEAD") });
		expect(textOf(out)).toContain(requests[0]?.id ?? "?");
		expect(await ofKind(h, "gate")).toEqual([]);
	});

	test("No adapter available", async () => {
		const h = await change("define");
		const out = await h.call("spec_gate", { target: "define" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("interaction.adapter");
		expect(await h.world.forge.listComments(h.n)).toEqual([]);
	});

	test("Waive at the gate", async () => {
		registerSizeLimits();
		const h = await change("plan", { ui: human("waive"), files: SIZE_LIMITS_FLOW });
		await seedClassification(h);
		const out = await h.call("spec_gate", { target: "plan" });
		expect(out.isError).toBe(false);
		const gate = gateData((await ofKind(h, "gate"))[0]);
		expect(gate).toMatchObject({ phase: "plan", outcome: "approved", choice: "waive", waivers: ["size-limits"] });
		expect(gate.superseded).toBeUndefined();
		expect(await phaseLabels(h)).toEqual(["livespec:phase/build"]);
	});

	test("Approve without waiving", async () => {
		registerSizeLimits();
		const h = await change("plan", { config: FORGE_CHAIN, files: SIZE_LIMITS_FLOW });
		await seedClassification(h);
		const out = await h.call("spec_gate", { target: "plan" });
		expect(out.isError).toBe(false);
		const request = (await ofKind(h, "request"))[0];
		expect(request?.data).toMatchObject({ options: [{ id: "waive" }], snapshot: { failingWaivable: ["size-limits"] } });
		await h.world.setPermission("alice", "write");
		await h.world.postComment(h.n, "alice", "/livespec approve");
		await h.call("spec_status");
		expect(h.session.commandWarnings.join("\n")).toContain("choose waive");
		expect(await ofKind(h, "gate")).toEqual([]);
		expect(await phaseLabels(h)).toEqual(["livespec:phase/plan"]);
	});

	test("Named gate option recorded", async () => {
		registerGate("new-dependency", { checks: [], options: [{ id: "accept", label: "accept the dependency" }] });
		const h = await change("build", { ui: human("accept") });
		const out = await h.call("spec_gate", { target: "new-dependency" });
		expect(out.isError).toBe(false);
		const gate = gateData((await ofKind(h, "gate"))[0]);
		expect(gate).toMatchObject({ gate: "new-dependency", choice: "accept", outcome: "approved", waivers: [] });
		expect(gate.superseded).toBeUndefined();
		expect(await phaseLabels(h)).toEqual(["livespec:phase/build"]);
	});

	test("Named gate option does not waive", async () => {
		registerSizeLimits();
		registerGate("new-dependency", { checks: ["size-limits"], options: [{ id: "accept", label: "accept the dependency" }] });
		const flow = { ".pi/livespec/flow.yaml": "extends: agent-skills\nphases:\n  - id: build\n    checks: [size-limits]\n" };
		const h = await change("build", { ui: human("accept"), files: flow });
		const out = await h.call("spec_gate", { target: "new-dependency" });
		expect(textOf(out)).toContain("choose waive");
		const gate = gateData((await ofKind(h, "gate"))[0]);
		expect(gate).toMatchObject({ gate: "new-dependency", choice: "accept", superseded: true, waivers: [] });
		expect(gate.outcome).toBe("approved");
	});

	test("plan gate locks digests and offers overrides", async () => {
		const h = await change("plan", { ui: human("approve") });
		await seedClassification(h);
		h.session.activeTree = "/home/u/.pi/livespec/agent-skills/trees/0123abc";
		await h.call("spec_gate", { target: "plan" });
		const units = parseChange(await h.world.bodyOf(h.n)).units;
		const gate = gateData((await ofKind(h, "gate"))[0]);
		expect(gate.locked).toEqual(Object.fromEntries(units.map((u) => [u.id, unitDigest(u)])));
		expect(gate.agent_skills).toBe("0123abc");
		const titles = h.ctx.ui.select.mock.calls.map((c) => c[0]);
		expect(titles).toContain("Adjust Difficulty or Tags?");
	});

	test("Old approval not reused after a cascade", async () => {
		const h = await change("define");
		await seedGate(h, "define", "r1");
		await seedGate(h, "plan", "r2");
		const stale = { reason: "Q3 answer changes rate-limit", phases: ["define", "plan", "build", "review", "ship", "close"], units: [], after_plan: true };
		await seedMarked(h, writeMarked("stale", "Q3", stale));
		const out = await h.call("spec_next");
		expect(await phaseLabels(h)).toEqual(["livespec:phase/define"]);
		expect(textOf(out)).toContain("Ready for the define gate.");
	});

	test("Superseded result does not fall back", async () => {
		const h = await change("define");
		await seedGate(h, "define", "r1");
		await seedGate(h, "define", "r2", { superseded: true });
		const out = await h.call("spec_next");
		expect(await phaseLabels(h)).toEqual(["livespec:phase/define"]);
		expect(textOf(out)).toContain("request the gate again");
	});

	test("Failed move retried", async () => {
		let failing = true;
		const h = await change("define", {
			ui: human("approve"),
			forge: (world) =>
				new Proxy(world.forge, {
					get(target, prop, receiver) {
						if (prop === "addLabels" && failing) {
							return async () => {
								failing = false;
								throw new Error("label write failed");
							};
						}
						return Reflect.get(target, prop, receiver);
					},
				}),
		});
		await h.call("spec_gate", { target: "define" });
		expect(await ofKind(h, "gate")).toHaveLength(1);
		expect(await phaseLabels(h)).toEqual(["livespec:phase/define"]);
		await h.call("spec_status");
		expect(await phaseLabels(h)).toEqual(["livespec:phase/plan"]);
		expect(await ofKind(h, "gate")).toHaveLength(1);
	});

	test("Ship approved", async () => {
		const h = await change("ship", { ui: human("approve"), edit: allDone });
		const out = await h.call("spec_gate", { target: "ship" });
		expect(out.isError).toBe(false);
		expect(gateData((await ofKind(h, "gate"))[0])).toMatchObject({ phase: "ship", outcome: "approved" });
		expect(await phaseLabels(h)).toEqual(["livespec:phase/ship"]);
		expect(textOf(out)).toContain("The ship gate is approved: the change is ready to ship.");
	});

	test("Changes requested", async () => {
		const h = await change("define", { ui: human("request changes", "tighten the cap") });
		const out = await h.call("spec_gate", { target: "define" });
		expect(gateData((await ofKind(h, "gate"))[0])).toMatchObject({ outcome: "changes_requested", notes: "tighten the cap" });
		const stale = await ofKind(h, "stale");
		expect(stale).toHaveLength(1);
		expect(gateData(stale[0]).phases).toEqual(["plan", "build", "review", "ship", "close"]);
		expect(await phaseLabels(h)).toEqual(["livespec:phase/define"]);
		expect(textOf(out)).toContain("The define gate requested changes: revise, then request the gate again.");
	});

	test("changes requested on the forge show the human's notes in the next step", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		await h.call("spec_gate", { target: "define" });
		await h.world.setPermission("alice", "write");
		await h.world.postComment(h.n, "alice", "/livespec changes cover <IPv6> too");
		const out = await h.call("spec_next");
		expect(textOf(out)).toContain("The define gate requested changes: revise, then request the gate again. Notes: cover &lt;IPv6> too");
		expect(textOf(out)).not.toContain("cover <IPv6>");
	});

	test("in-session changes requested show the notes in the tool result", async () => {
		const h = await change("define", { ui: human("request changes", "tighten the cap") });
		const out = await h.call("spec_gate", { target: "define" });
		expect(textOf(out)).toContain(`Notes: <untrusted>tighten the cap</untrusted>`);
	});

	test("Dismissed", async () => {
		const h = await change("plan", { ui: human("dismiss") });
		await seedClassification(h);
		const out = await h.call("spec_gate", { target: "plan" });
		expect(gateData((await ofKind(h, "gate"))[0])).toMatchObject({ phase: "plan", outcome: "dismissed" });
		expect(await phaseLabels(h)).toEqual(["livespec:phase/plan"]);
		expect(textOf(out)).toContain("The plan gate was dismissed: ask the human how to proceed.");
	});

	test("refusal writes nothing", async () => {
		const h = await change("define", { ui: human("approve"), edit: (b) => b.replace("- [x] Q1 (blocking)", "- [ ] Q1 (blocking)") });
		const out = await h.call("spec_gate", { target: "define" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("Q1");
		expect(h.ctx.ui.select).not.toHaveBeenCalled();
		expect(await h.world.forge.listComments(h.n)).toEqual([]);
	});

	test("Dismissed stuck answer keeps the cap", async () => {
		const h = await change("define", { ui: human("approve") });
		const stale = (id: string) => writeMarked("stale", id, { reason: id, phases: ["define"], units: [], after_plan: true });
		for (const id of ["Q3", "Q4", "Q5", "Q6", "Q7"]) await seedMarked(h, stale(id));
		await seedMarked(h, writeMarked("stuck", "S1", { where: "x", tried: [], hypothesis: "h", options: [{ id: "A", label: "a" }], recommended: "A" }));
		await seedMarked(h, writeMarked("stuck", "S1-answer", { request: "stuck-S1.x", outcome: "dismissed", notes: "", by: "alice", at: AT, adapter: "forge" }));
		const out = await h.call("spec_gate", { target: "define" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("new stuck report");
		expect(card(h).step.next).toContain("spec_stuck");
		expect(await ofKind(h, "gate")).toEqual([]);
	});

	test("Waived ship gate stays in ship", async () => {
		registerSizeLimits();
		const flow = { ".pi/livespec/flow.yaml": "extends: agent-skills\nphases:\n  - id: ship\n    checks: [size-limits]\n" };
		const h = await change("ship", { ui: human("waive"), edit: allDone, files: flow });
		const out = await h.call("spec_gate", { target: "ship" });
		expect(out.isError).toBe(false);
		expect(gateData((await ofKind(h, "gate"))[0])).toMatchObject({ phase: "ship", outcome: "approved", waivers: ["size-limits"] });
		expect(await phaseLabels(h)).toEqual(["livespec:phase/ship"]);
		expect(card(h).step.next).toContain("ready to ship");
	});

	test("Dirty tree when the answer is read", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		await h.call("spec_gate", { target: "define" });
		await writeIn(h.root, "scratch.txt", "x");
		await h.world.setPermission("alice", "write");
		await h.world.postComment(h.n, "alice", "/livespec approve");
		await pollApprovals(h.session);
		expect(gateData((await ofKind(h, "gate"))[0]).superseded).toBe(true);
		expect((await ofKind(h, "answer"))[0]?.data).toMatchObject({ verdict: "superseded", reason: expect.stringContaining("working tree is dirty") });
		expect(await phaseLabels(h)).toEqual(["livespec:phase/define"]);
		const requests = readRequests(await marked(h));
		expect(requests.pending).toEqual([]);
		expect(requests.applying).toEqual([]);
	});

	test("unknown target is refused", async () => {
		const h = await change("define", { ui: human("approve") });
		const out = await h.call("spec_gate", { target: "deploy" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("neither the current phase");
	});
});
