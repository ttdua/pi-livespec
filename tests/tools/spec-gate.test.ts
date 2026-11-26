import { BRIEFING } from "../helpers/briefing.ts";
import { readFileSync } from "node:fs";
import { pickById } from "../helpers/menu.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { replaceSection } from "../../src/core/sections.ts";
import { decisionComment } from "../../src/decide/records.ts";
import { registerGate, resetGatesForTests } from "../../src/engine/gates.ts";
import { pollApprovals } from "../../src/interaction/poll.ts";
import { readRequests } from "../../src/interaction/requests.ts";
import { registerCheck } from "../../src/engine/registry.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { prepareWrite, requireChange } from "../../src/tools/guard.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import type { ChangeState } from "../../src/engine/state-types.ts";
import { type GatePlan, gateRequest, sendNamedGate } from "../../src/tools/spec-gate.ts";
import { registerSizeLimits as registerSizeLimitsCheck } from "../../src/initiatives/size-limits.ts";
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

/** The real check needs a worktree run per unit; these tests are about the gate, so it reports nothing. */
const passRedOnBase = (): void => registerCheck("verify-red-on-base", async () => [], { waivable: true, at: "gate", key: () => "stub" });

beforeEach(() => {
	passRedOnBase();
	// A test may replace `size-limits` with a failing stub; every other test runs the real check.
	registerSizeLimitsCheck();
});

const SPEC = readFileSync(new URL("../fixtures/rate-limit.spec.md", import.meta.url), "utf8");
const AT = "2026-11-15T10:00:00.000Z";
const FORGE_CHAIN = "integrationBranch: main\ninteraction: { adapter: [forge] }\n";
const BOTH_CHAIN = "integrationBranch: main\ninteraction: { adapter: [in-session, forge] }\n";
const labels = (phase: string) => ["livespec", `livespec:phase/${phase}`];

type Opts = { config?: string; ui?: FakeUI; files?: Record<string, string>; forge?: (world: MemoryWorld) => Forge; edit?: (b: string) => string };
type Gate = ToolHarness & { n: number };

/** Every unit done and a Durable docs table that covers the spec file the fixture commits. */
const shipReady = (body: string): string => replaceSection(noPr(body), "Durable docs", "| File | Status |\n|---|---|\n| specs/rate-limit/spec.md | updated |");
/** Every unit done and no `PR` line: the ship gate decides the next step. */
const noPr = (body: string): string => allDone(body).replace(/^PR: .*\n/m, "");

/** In `ship`, the review gate passed at HEAD, so the ship steps do not send the change back to review. */
const reviewedAtHead = (head: string): string =>
	writeMarked("gate", "review.self-1", { phase: "review", outcome: "approved", notes: "", by: "livespec", at: AT, adapter: "livespec", head_sha: head, waivers: [] });

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
	if (phase === "ship") await h.world.postComment(n, BOT_LOGIN, reviewedAtHead(h.git("rev-parse", "HEAD")));
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

/** The `ship` gate comments, without the review gate `change("ship")` seeds. */
async function shipGates(h: Gate): Promise<MarkedComment[]> {
	return (await ofKind(h, "gate")).filter((m) => gateData(m).phase === "ship");
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
		return pickById(options, pick);
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

/** The fixture plan grown to nine units (U3 cloned as U4…U10), one more than `max_units` 8 of the default pack. */
function nineUnits(body: string): string {
	const u3 = /### U3 — [\s\S]*?- \[ \] pending\n/.exec(body)?.[0] ?? "";
	const clones = [4, 5, 6, 7, 8, 9, 10].map((i) => `\n${u3.replace("### U3 —", `### U${i} —`)}`).join("");
	return body.replace(u3, `${u3}${clones}`);
}

describe("spec_gate", () => {
	test("Self gate", async () => {
		const h = await change("shape");
		const out = await h.call("spec_gate", { target: "shape", briefing: BRIEFING });
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
		const out = await h.call("spec_gate", { target: "plan", briefing: BRIEFING });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("size-limits");
		expect(await ofKind(h, "gate")).toEqual([]);
	});

	test("Registered gate", async () => {
		registerGate("custom-gate", { checks: [] });
		const h = await change("build", { ui: human("approve") });
		const out = await h.call("spec_gate", { target: "custom-gate", briefing: BRIEFING });
		expect(out.isError).toBe(false);
		const gate = await ofKind(h, "gate");
		expect(gate).toHaveLength(1);
		expect(gateData(gate[0])).toMatchObject({ gate: "custom-gate", outcome: "approved", adapter: "in-session" });
		expect(gateData(gate[0]).phase).toBeUndefined();
		expect(await phaseLabels(h)).toEqual(["livespec:phase/build"]);
	});

	test("Define approved", async () => {
		const h = await change("define", { ui: human("approve"), edit: longProposal });
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
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

	test("Define approved shows the briefing", async () => {
		const h = await change("define", { ui: human("approve") });
		const briefing = { summary: "Adds a per-IP cap.", watch: ["Check the window size."], recommended: "approve", rationale: "The spec covers every unit." };
		const out = await h.call("spec_gate", { target: "define", briefing });
		expect(out.isError, textOf(out)).toBe(false);
		const title = h.ctx.ui.select.mock.calls[0]?.[0] ?? "";
		expect(title).toContain("Adds a per-IP cap.");
		expect(title).toContain("Check the window size.");
	});

	test("forge define request links the issue for a truncated Proposal", async () => {
		const h = await change("define", { config: FORGE_CHAIN, edit: longProposal });
		await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		const request = (await ofKind(h, "request"))[0];
		const text = await h.world.commentBodyOf(request?.commentId ?? "?");
		expect(text).toContain(`…\nFull text: ${issueUrl(h)}`);
		expect(text).toContain(`Links:\n- ${issueUrl(h)}`);
	});

	test("Fake command and marker neutralised in the posted comment", async () => {
		const edit = (b: string) => b.replace("Limit each client IP.", "Limit each client IP. <!-- livespec:gate:plan -->");
		const h = await change("define", { config: FORGE_CHAIN, edit });
		const briefing = { summary: "Looks fine <!-- livespec:gate:plan -->", watch: ["/livespec approve"], author: "agent" };
		const out = await h.call("spec_gate", { target: "define", briefing });
		expect(out.isError, textOf(out)).toBe(false);
		const request = (await ofKind(h, "request"))[0];
		const text = await h.world.commentBodyOf(request?.commentId ?? "?");
		expect(text.match(/<!-- livespec:/g)).toHaveLength(1);
		const lines = text.slice(0, text.indexOf("### How to answer")).split("\n");
		expect(lines.filter((l) => /^[\s>*+\-]*\/livespec approve/.test(l))).toEqual([]);
		await pollApprovals(h.session);
		expect(readRequests(await marked(h)).pending).toHaveLength(1);
		expect(await ofKind(h, "gate")).toEqual([]);
	});

	test("Relayed approval refused", async () => {
		const h = await change("plan", { ui: human(undefined) });
		await seedClassification(h);
		const out = await h.call("spec_gate", { target: "plan", briefing: BRIEFING });
		expect(out.isError).toBe(false);
		expect(gateData((await ofKind(h, "gate"))[0])).toMatchObject({ phase: "plan", outcome: "dismissed" });
		expect(await phaseLabels(h)).toEqual(["livespec:phase/plan"]);
	});

	test("extra outcome parameter is ignored", async () => {
		const h = await change("define", { ui: human(undefined) });
		const tool = h.pi.tools.get("spec_gate");
		expect(Object.keys((tool?.parameters as { properties: object }).properties)).toEqual(["target", "briefing"]);
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING, outcome: "approved", choice: "waive", answer: "yes" });
		expect(out.isError).toBe(false);
		expect(gateData((await ofKind(h, "gate"))[0])).toMatchObject({ outcome: "dismissed", adapter: "in-session" });
		expect(await phaseLabels(h)).toEqual(["livespec:phase/define"]);
	});

	test("Unavailable without UI", async () => {
		const h = await change("define", { config: BOTH_CHAIN });
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
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
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("interaction.adapter");
		expect(await h.world.forge.listComments(h.n)).toEqual([]);
	});

	test("Waive at the gate", async () => {
		registerSizeLimits();
		const h = await change("plan", { ui: human("waive"), files: SIZE_LIMITS_FLOW });
		await seedClassification(h);
		const out = await h.call("spec_gate", { target: "plan", briefing: BRIEFING });
		expect(out.isError).toBe(false);
		const gate = gateData((await ofKind(h, "gate"))[0]);
		expect(gate).toMatchObject({ phase: "plan", outcome: "approved", choice: "waive", waivers: ["size-limits"] });
		expect(gate.superseded).toBeUndefined();
		expect(await phaseLabels(h)).toEqual(["livespec:phase/build"]);
	});

	test("Over the unit limit", async () => {
		const h = await change("plan", { config: FORGE_CHAIN, edit: nineUnits });
		await seedClassification(h);
		expect(parseChange(await h.world.bodyOf(h.n)).units).toHaveLength(9);
		await h.call("spec_gate", { target: "plan", briefing: BRIEFING });
		const request = (await ofKind(h, "request"))[0];
		expect(request?.data).toMatchObject({ options: [{ id: "waive" }], snapshot: { failingWaivable: ["size-limits"] } });
		await h.world.setPermission("alice", "write");
		await h.world.postComment(h.n, "alice", "/livespec approve");
		await h.call("spec_status");
		expect(h.session.commandWarnings.join("\n")).toContain("choose waive");
		expect(await ofKind(h, "gate")).toEqual([]);
		expect(await phaseLabels(h)).toEqual(["livespec:phase/plan"]);
	});

	test("over the unit limit, in session approve is not offered", async () => {
		const h = await change("plan", { ui: human("approve"), edit: nineUnits });
		await seedClassification(h);
		await h.call("spec_gate", { target: "plan", briefing: BRIEFING });
		const options = h.ctx.ui.select.mock.calls[0]?.[1] ?? [];
		expect(options).not.toContain("approve");
		expect(gateData((await ofKind(h, "gate"))[0])).toMatchObject({ phase: "plan", outcome: "dismissed" });
		expect(await phaseLabels(h)).toEqual(["livespec:phase/plan"]);
	});

	test("Waived", async () => {
		const h = await change("plan", { ui: human("waive"), edit: nineUnits });
		await seedClassification(h);
		const out = await h.call("spec_gate", { target: "plan", briefing: BRIEFING });
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
		const out = await h.call("spec_gate", { target: "plan", briefing: BRIEFING });
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
		registerGate("custom-gate", { checks: [], options: [{ id: "accept", label: "accept the dependency" }] });
		const h = await change("build", { ui: human("accept") });
		const out = await h.call("spec_gate", { target: "custom-gate", briefing: BRIEFING });
		expect(out.isError).toBe(false);
		const gate = gateData((await ofKind(h, "gate"))[0]);
		expect(gate).toMatchObject({ gate: "custom-gate", choice: "accept", outcome: "approved", waivers: [] });
		expect(gate.superseded).toBeUndefined();
		expect(await phaseLabels(h)).toEqual(["livespec:phase/build"]);
	});

	test("Named gate option does not waive", async () => {
		registerSizeLimits();
		registerGate("custom-gate", { checks: ["size-limits"], options: [{ id: "accept", label: "accept the dependency" }] });
		const flow = { ".pi/livespec/flow.yaml": "extends: agent-skills\nphases:\n  - id: build\n    checks: [size-limits]\n" };
		const h = await change("build", { ui: human("accept"), files: flow });
		const out = await h.call("spec_gate", { target: "custom-gate", briefing: BRIEFING });
		expect(textOf(out)).toContain("choose waive");
		const gate = gateData((await ofKind(h, "gate"))[0]);
		expect(gate).toMatchObject({ gate: "custom-gate", choice: "accept", superseded: true, waivers: [] });
		expect(gate.outcome).toBe("approved");
	});

	test("plan gate locks digests and offers overrides", async () => {
		const h = await change("plan", { ui: human("approve") });
		await seedClassification(h);
		h.session.activeTree = "/home/u/.pi/livespec/agent-skills/trees/0123abc";
		await h.call("spec_gate", { target: "plan", briefing: BRIEFING });
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
		const review = { role: "reviewer", subject: "spec", round: 1, status: "DONE", advisory: true, head: h.git("rev-parse", "HEAD"), packet: "p", sources_used: [], required: [], completed: true, agentSource: "s", requested: { thinking: "low" }, effective: {}, findings: [] };
		await seedMarked(h, writeMarked("finding-summary", "finding-summary.change.spec.1", review));
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
		await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(await ofKind(h, "gate")).toHaveLength(1);
		expect(await phaseLabels(h)).toEqual(["livespec:phase/define"]);
		await h.call("spec_status");
		expect(await phaseLabels(h)).toEqual(["livespec:phase/plan"]);
		expect(await ofKind(h, "gate")).toHaveLength(1);
	});

	test("ship gate is refused naming durable-docs when the ship context cannot be built", async () => {
		const h = await change("ship", { ui: human("approve"), edit: shipReady, config: "# no integrationBranch\n" });
		const out = await h.call("spec_gate", { target: "ship", briefing: BRIEFING });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("durable-docs");
		expect(await shipGates(h)).toEqual([]);
	});

	test("Ship approved", async () => {
		const h = await change("ship", { ui: human("approve"), edit: shipReady });
		const out = await h.call("spec_gate", { target: "ship", briefing: BRIEFING });
		expect(out.isError).toBe(false);
		expect(gateData((await shipGates(h))[0])).toMatchObject({ phase: "ship", outcome: "approved" });
		expect(await phaseLabels(h)).toEqual(["livespec:phase/ship"]);
		expect(textOf(out)).toContain("The ship gate is approved: run change_ship.");
	});

	test("Changes requested", async () => {
		const h = await change("define", { ui: human("request changes", "tighten the cap") });
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(gateData((await ofKind(h, "gate"))[0])).toMatchObject({ outcome: "changes_requested", notes: "tighten the cap" });
		const stale = await ofKind(h, "stale");
		expect(stale).toHaveLength(1);
		expect(gateData(stale[0]).phases).toEqual(["plan", "build", "review", "ship", "close"]);
		expect(await phaseLabels(h)).toEqual(["livespec:phase/define"]);
		expect(textOf(out)).toContain("The define gate requested changes: revise, then request the gate again.");
	});

	test("changes requested on the forge show the human's notes in the next step", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		await h.world.setPermission("alice", "write");
		await h.world.postComment(h.n, "alice", "/livespec changes cover <IPv6> too");
		const out = await h.call("spec_next");
		expect(textOf(out)).toContain("The define gate requested changes: revise, then request the gate again. Notes: cover &lt;IPv6> too");
		expect(textOf(out)).not.toContain("cover <IPv6>");
	});

	test("in-session changes requested show the notes in the tool result", async () => {
		const h = await change("define", { ui: human("request changes", "tighten the cap") });
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(textOf(out)).toContain(`Notes: <untrusted>tighten the cap</untrusted>`);
	});

	test("Dismissed", async () => {
		const h = await change("plan", { ui: human("dismiss") });
		await seedClassification(h);
		const out = await h.call("spec_gate", { target: "plan", briefing: BRIEFING });
		expect(gateData((await ofKind(h, "gate"))[0])).toMatchObject({ phase: "plan", outcome: "dismissed" });
		expect(await phaseLabels(h)).toEqual(["livespec:phase/plan"]);
		expect(textOf(out)).toContain("The plan gate was dismissed: ask the human how to proceed.");
	});

	test("refusal writes nothing", async () => {
		const h = await change("define", { ui: human("approve"), edit: (b) => b.replace("- [x] Q1 (blocking)", "- [ ] Q1 (blocking)") });
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
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
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("new stuck report");
		expect(card(h).step.next).toContain("spec_stuck");
		expect(await ofKind(h, "gate")).toEqual([]);
	});

	test("Waived ship gate stays in ship", async () => {
		registerSizeLimits();
		const flow = { ".pi/livespec/flow.yaml": "extends: agent-skills\nphases:\n  - id: ship\n    checks: [size-limits]\n" };
		const h = await change("ship", { ui: human("waive"), edit: noPr, files: flow });
		const out = await h.call("spec_gate", { target: "ship", briefing: BRIEFING });
		expect(out.isError).toBe(false);
		expect(gateData((await shipGates(h))[0])).toMatchObject({ phase: "ship", outcome: "approved", waivers: ["size-limits"] });
		expect(await phaseLabels(h)).toEqual(["livespec:phase/ship"]);
		expect(card(h).step.next).toBe("The ship gate is approved: run change_ship.");
	});

	test("Dirty tree when the answer is read", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		await h.call("spec_gate", { target: "define", briefing: BRIEFING });
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
		const out = await h.call("spec_gate", { target: "deploy", briefing: BRIEFING });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("neither the current phase");
	});
});

describe("spec_gate gate-only checks", () => {
	test("a gate-only check runs before the refusals and its result reaches the refusal", async () => {
		registerCheck("verify-red-on-base", async () => [{ code: "verify-red-on-base", severity: "error", message: "U1 is green on Base" }], { at: "gate", key: () => "k" });
		const h = await change("plan", { files: { ".pi/livespec/flow.yaml": "extends: agent-skills\nphases:\n  - id: plan\n    gate: self\n" } });
		await seedClassification(h);
		const out = await h.call("spec_gate", { target: "plan", briefing: BRIEFING });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("verify-red-on-base");
		expect(await ofKind(h, "gate")).toEqual([]);
	});
});

describe("named gate payload", () => {
	test("a named gate's review payload lists its gate-only check results", async () => {
		registerCheck("dep-audit", async () => [{ code: "dep-audit", severity: "warning", message: "left-pad is unmaintained" }], { at: "gate", key: () => "k" });
		registerGate("custom-gate", { checks: ["dep-audit"] });
		const h = await change("build", { ui: human("approve") });
		await h.call("spec_gate", { target: "custom-gate", briefing: BRIEFING });
		const summary = h.ctx.ui.select.mock.calls[0]?.[0] ?? "";
		expect(summary).toContain("Gate checks:");
		expect(summary).toContain("dep-audit (warning): left-pad is unmaintained");
	});
});

describe("named gates with a proposer", () => {
	test("Gate with a proposer", async () => {
		registerGate("initiative", { checks: [], proposer: "initiative_propose" });
		const h = await change("build", { config: FORGE_CHAIN });
		const out = await h.call("spec_gate", { target: "initiative", briefing: BRIEFING });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("initiative_propose");
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("sendNamedGate sends its drafts and options with a dirty tree", async () => {
		registerGate("new-dependency", { checks: [], options: [{ id: "A", label: "A (default)" }, { id: "split", label: "split" }], proposer: "new_dependency" });
		const h = await change("build", { config: FORGE_CHAIN });
		await writeIn(h.root, "src/lane.ts", "wip\n");
		const w = await prepareWrite();
		if (!w.ok) throw new Error(w.message);
		const state = requireChange(w.session);
		if (!state.ok) throw new Error(state.message);
		expect(state.state.git.dirty).toBe(true);
		const drafts = { a: { name: "dep" } };
		const out = await sendNamedGate(w, state.state, { target: "new-dependency", options: [{ id: "A", label: "A (default)" }], drafts, summary: "New dependency found.", ctx: h.ctx as never, tool: "new_dependency" });
		expect(out.isError).toBe(false);
		const request = (await ofKind(h, "request"))[0]?.data as { subject: string; options: { id: string }[]; snapshot: { target: string; drafts: unknown }; summary: string };
		expect(request.subject).toBe("gate:new-dependency");
		expect(request.options.map((o) => o.id)).toEqual(["A"]);
		expect(request.snapshot).toMatchObject({ target: "new-dependency", drafts });
		expect(request.summary).toContain("New dependency found.");
	});

	test("sendNamedGate still refuses a pending request", async () => {
		registerGate("new-dependency", { checks: [], proposer: "new_dependency" });
		const h = await change("build", { config: FORGE_CHAIN });
		const send = async () => {
			const w = await prepareWrite();
			if (!w.ok) throw new Error(w.message);
			const state = requireChange(w.session);
			if (!state.ok) throw new Error(state.message);
			return sendNamedGate(w, state.state, { target: "new-dependency", options: [], drafts: {}, summary: "s", ctx: h.ctx as never, tool: "new_dependency" });
		};
		expect((await send()).isError).toBe(false);
		const again = await send();
		expect(again.isError).toBe(true);
		expect(textOf(again)).toContain("pending");
		expect(await ofKind(h, "request")).toHaveLength(1);
	});

	describe("briefing", () => {
		test("Human gate without a briefing", async () => {
			let ran = 0;
			registerCheck("verify-red-on-base", async () => (ran++, []), { waivable: true, at: "gate", key: () => "stub" });
			const h = await change("plan", { config: FORGE_CHAIN });
			await seedClassification(h);
			for (const briefing of [undefined, "text"]) {
				const out = await h.call("spec_gate", { target: "plan", ...(briefing === undefined ? {} : { briefing }) });
				expect(out.isError).toBe(true);
				expect(textOf(out)).toContain("briefing");
			}
			expect(ran).toBe(0);
			expect(await ofKind(h, "request")).toEqual([]);
			expect((await marked(h)).filter((m) => m.kind === "decide")).toEqual([]);
		});

		test("Missing briefing names what it must contain", async () => {
			const h = await change("define", { config: FORGE_CHAIN });
			const out = await h.call("spec_gate", { target: "define" });
			expect(textOf(out)).toMatch(/summary/);
			expect(await ofKind(h, "request")).toEqual([]);
		});

		test("Rationale missing", async () => {
			const h = await change("define", { config: FORGE_CHAIN });
			const out = await h.call("spec_gate", { target: "define", briefing: { summary: "s", recommended: "approve" } });
			expect(out.isError).toBe(true);
			expect(textOf(out)).toContain("rationale");
			expect(await ofKind(h, "request")).toEqual([]);
		});

		test("Self gate ignores the briefing", async () => {
			for (const briefing of [undefined, { nonsense: true }, 7]) {
				const h = await change("shape");
				const out = await h.call("spec_gate", { target: "shape", ...(briefing === undefined ? {} : { briefing }) });
				expect(out.isError, textOf(out)).toBe(false);
				expect(await ofKind(h, "gate")).toHaveLength(1);
				await cleanupDirs();
			}
		});

		test("Approve not recommended while a check must be waived", async () => {
			registerSizeLimits();
			const h = await change("plan", { config: FORGE_CHAIN, files: SIZE_LIMITS_FLOW });
			await seedClassification(h);
			const bad = await h.call("spec_gate", { target: "plan", briefing: { summary: "s", recommended: "approve", rationale: "r" } });
			expect(bad.isError).toBe(true);
			expect(textOf(bad)).toContain("waive");
			expect(await ofKind(h, "request")).toEqual([]);
			const good = await h.call("spec_gate", { target: "plan", briefing: { summary: "s", recommended: "waive", rationale: "r" } });
			expect(good.isError, textOf(good)).toBe(false);
			const request = (await ofKind(h, "request"))[0]?.data as { briefing: { recommended: string; author: string } };
			expect(request.briefing).toMatchObject({ recommended: "waive", author: "agent" });
		});

		test("Recommend waive only when offered", async () => {
			const h = await change("define", { config: FORGE_CHAIN });
			const out = await h.call("spec_gate", { target: "define", briefing: { summary: "s", recommended: "waive", rationale: "r" } });
			expect(out.isError).toBe(true);
			expect(textOf(out)).toContain("approve, changes, dismiss");
			expect(await ofKind(h, "request")).toEqual([]);
		});

		test("sendNamedGate refuses a recommendation it does not offer", async () => {
			registerGate("new-dependency", { checks: [], proposer: "new_dependency" });
			const h = await change("build", { config: FORGE_CHAIN });
			const w = await prepareWrite();
			if (!w.ok) throw new Error(w.message);
			const state = requireChange(w.session);
			if (!state.ok) throw new Error(state.message);
			const briefing = { summary: "s", recommended: "C", rationale: "r", author: "agent" as const };
			const out = await sendNamedGate(w, state.state, { target: "new-dependency", options: [{ id: "A", label: "A" }], drafts: {}, summary: "s", ctx: h.ctx as never, tool: "new_dependency", briefing });
			expect(out.isError).toBe(true);
			expect(await ofKind(h, "request")).toEqual([]);
		});
	});
});

describe("gateRequest overridable.current", () => {
	const units = [
		{ id: "U1", difficulty: "high", tags: ["security"] },
		{ id: "U2", difficulty: "odd" },
		{ id: "U3" },
	];
	const state = { git: { head: "abc" }, phase: { kind: "ok", id: "plan" }, issue: { number: 7 }, change: { units } } as unknown as ChangeState;
	const plan: GatePlan = { mode: "human", isPhase: true, failingWaivable: [], options: [] };
	const input = { body: "body", payload: { summary: "s", links: [], files: [], findings: [] }, now: new Date(0) };

	test("plan gate carries the current values of every unit", () => {
		const r = gateRequest(state, {} as Pack, "plan", plan, input);
		expect(r.overridable?.units).toEqual(["U1", "U2", "U3"]);
		expect(r.overridable?.current).toEqual({
			U1: { difficulty: "high", tags: ["security"] },
			U2: { tags: [] },
			U3: { tags: [] },
		});
	});

	test("other gates have no overridable units", () => {
		expect(gateRequest(state, {} as Pack, "define", plan, input).overridable).toBeUndefined();
	});
});
