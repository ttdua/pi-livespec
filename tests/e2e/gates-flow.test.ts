// End-to-end gate flow over a memory forge: every human decision of LS-05
// goes through the real tools, the approver chain and forge polling.

import { BRIEFING } from "../helpers/briefing.ts";
import { pickById, pickByLabel } from "../helpers/menu.ts";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { parseChange } from "../../src/core/change.ts";
import { setHeaderLine } from "../../src/core/sections.ts";
import type { UnitInput } from "../../src/core/unit-blocks.ts";
import { registerCheck } from "../../src/engine/registry.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { CHANGE_BODY_TEMPLATE } from "../../src/tools/change-new.ts";
import type { SelectFn } from "../hooks/fake-pi.ts";
import { allDone, CHANGE_BRANCH, resumeBody } from "../hooks/helpers.ts";
import { replaceSection } from "../../src/core/sections.ts";
import { writeMarked } from "../../src/forge/markers.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "../tools/helpers.ts";

beforeEach(() => registerCheck("verify-red-on-base", async () => [], { waivable: true, at: "gate", key: () => "stub" }));

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const SPEC = readFileSync(new URL("../fixtures/rate-limit.spec.md", import.meta.url), "utf8");
const PER_IP = "rate-limit/Requirement: Per-IP cap";
const FLOW = "extends: agent-skills\nloops: { change_iterations: 1 }\n";
const STUCK = {
	where: "the per-IP cap keeps moving",
	tried: [{ text: "per-IP window" }],
	hypothesis: "the requirement mixes two limits",
	options: [
		{ id: "A", label: "split the change", description: "Split the change so each part has one limit." },
		{ id: "B", label: "keep going", description: "Keep the change whole and iterate again." },
	],
	recommended: "A",
	rationale: "The requirement mixes two limits, so splitting removes the churn.",
};

function unit(title: string, file: string, label: string): UnitInput {
	return {
		title,
		covers: [PER_IP],
		files: [file],
		done_means: [{ label, text: `${title} works` }],
		scenarios: [{ label, ref: `test/${label}.test.ts › ${title}` }],
		depends: [],
		verify: `bun test ${label}`,
	};
}

/** The in-session human approves every gate summary and keeps notes and classification as they are. */
const approveAll: SelectFn = async (title, options) => {
	if (title === "Add notes?") return "No notes";
	if (title === "Adjust Difficulty or Tags?") return "Keep classification";
	return pickByLabel(options, "approve");
};

function card(h: ToolHarness) {
	const c = h.session.card;
	if (c.kind !== "change") throw new Error(`no change card: ${c.kind}`);
	return c;
}

async function phaseOf(h: ToolHarness, n: number): Promise<string[]> {
	return (await h.world.forge.getIssue(n)).labels.filter((l) => l.startsWith("livespec:phase/"));
}

/** Switches the project to `adapter`, committed so the tree stays clean for the gates. */
async function useAdapters(h: ToolHarness, adapter: string): Promise<void> {
	await writeIn(h.root, ".pi/livespec/config.yaml", `integrationBranch: main\ninteraction: { adapter: [${adapter}] }\n`);
	commitAll(h.root, `adapter ${adapter}`);
	h.session.config = await loadConfig(h.root, `${h.root}/.no-home`);
}

/** A writer comments on the issue; the next livespec tool polls and completes the answer. */
async function writerSays(h: ToolHarness, n: number, text: string): Promise<void> {
	await h.world.postComment(n, "alice", text);
	const out = await h.call("spec_status");
	expect(out.isError, textOf(out)).toBeFalsy();
}

describe("gates and decisions", () => {
	test("full gate flow over a memory forge", async () => {
		const h = await toolHarness({ branch: CHANGE_BRANCH, files: { ".pi/livespec/flow.yaml": FLOW }, ui: { hasUI: true, select: approveAll } });
		h.git("config", "user.name", "t");
		h.git("config", "user.email", "t@t");
		h.git("config", `branch.${CHANGE_BRANCH}.livespecBase`, h.head);
		await h.world.setPermission("alice", "write");

		// 1. A define change with a spec diff.
		await writeIn(h.root, "specs/rate-limit/spec.md", SPEC);
		commitAll(h.root, "spec");
		let body = setHeaderLine(setHeaderLine(CHANGE_BODY_TEMPLATE, "Base", h.head), "Branch", CHANGE_BRANCH);
		body = body.replace("Capabilities: new [], modified []", "Capabilities: new [rate-limit], modified []");
		body = body.replace("Product impact: —", "Product impact: updated");
		body = body.replace("## Proposal\n", "## Proposal\nLimit each client IP.\n");
		const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", "livespec:phase/define"] });
		await h.session.refresh();

		// 2. The define gate, approved in session.
		const define = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(define.isError, textOf(define)).toBe(false);
		await h.call("spec_status");
		expect(await phaseOf(h, n)).toEqual(["livespec:phase/plan"]);

		// 3. Units.
		const planned = await h.call("plan_units", { units: [unit("Counter", "src/limits/counter.ts", "c"), unit("Readme note", "README.md", "r")] });
		expect(planned.isError, textOf(planned)).toBe(false);

		// 4. The plan gate over the forge, approved by a writer's command.
		await useAdapters(h, "forge");
		const plan = await h.call("spec_gate", { target: "plan", briefing: BRIEFING });
		expect(plan.isError, textOf(plan)).toBe(false);
		expect(card(h).step.pending).toEqual([expect.objectContaining({ subject: "gate:plan", adapter: "forge" })]);
		await writerSays(h, n, "/livespec approve");
		expect(await phaseOf(h, n)).toEqual(["livespec:phase/build"]);
		expect(card(h).state.lock.locked).toBeDefined();

		// 5. A web edit freezes U2; the amendment is approved and unfreezes it.
		await h.world.editBodyBehindBack(n, (await h.world.bodyOf(n)).replace("Verify: `bun test r`", "Verify: `bun test readme`"));
		await h.session.refresh();
		expect(card(h).state.lock.frozen).toEqual(["U2"]);
		const amend = await h.call("unit_amend", { unit: "U2", replacement: { ...unit("Readme note", "README.md", "r"), verify: "bun test readme" } });
		expect(amend.isError, textOf(amend)).toBe(false);
		await writerSays(h, n, "/livespec approve");
		expect(card(h).state.lock.frozen).toEqual([]);

		// 6. U1 ticked.
		await h.world.editBodyBehindBack(n, (await h.world.bodyOf(n)).replace(/(### U1 — [\s\S]*?)- \[ \] pending/, "$1- [x] done"));
		await h.session.refresh();
		expect(parseChange(await h.world.bodyOf(n)).units.find((u) => u.id === "U1")?.done).toBe(true);

		// 7. A plain answer: Q1 is answered and the change stays where it is.
		const asked = await h.call("spec_question", { text: "Is the cap per IP or per token?" });
		expect(asked.isError, textOf(asked)).toBe(false);
		await writerSays(h, n, "/livespec answer Q1 per client token");
		expect(parseChange(await h.world.bodyOf(n)).questions.find((q) => q.id === "Q1")?.checked).toBe(true);
		expect(await phaseOf(h, n)).toEqual(["livespec:phase/build"]);
		expect(parseChange(await h.world.bodyOf(n)).units.find((u) => u.id === "U1")?.done).toBe(true);

		// Five counted cascades, seeded directly, reach the cap and send the change back to define.
		for (let i = 1; i <= 5; i++) {
			await h.world.postComment(n, BOT_LOGIN, writeMarked("stale", `Q${10 + i}`, { reason: `Q${10 + i}`, phases: ["define"], units: [], after_plan: true }));
		}
		await h.world.forge.removeLabels(n, ["livespec:phase/build"]);
		await h.world.forge.addLabels(n, ["livespec:phase/define"]);
		await h.session.refresh();
		expect(card(h).state.counters.change_iterations).toBe(5);

		const capped = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(capped.isError).toBe(true);
		expect(textOf(capped)).toContain("spec_stuck");

		const stuck = await h.call("spec_stuck", STUCK);
		expect(stuck.isError, textOf(stuck)).toBe(false);
		await writerSays(h, n, "/livespec choose A");
		expect(card(h).state.iterations.blocking).toBe(false);
		expect(card(h).step.next).not.toContain("spec_stuck");
		const reopened = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(reopened.isError, textOf(reopened)).toBe(false);
	});

	test("Stale before the first lock", async () => {
		const h = await toolHarness({ branch: CHANGE_BRANCH, ui: { hasUI: true, select: approveAll } });
		h.git("config", "user.name", "t");
		h.git("config", "user.email", "t@t");
		h.git("config", `branch.${CHANGE_BRANCH}.livespecBase`, h.head);
		await h.world.setPermission("alice", "write");

		await writeIn(h.root, "specs/rate-limit/spec.md", SPEC);
		commitAll(h.root, "spec");
		let body = setHeaderLine(setHeaderLine(CHANGE_BODY_TEMPLATE, "Base", h.head), "Branch", CHANGE_BRANCH);
		body = body.replace("Capabilities: new [], modified []", "Capabilities: new [rate-limit], modified []");
		body = body.replace("Product impact: —", "Product impact: updated");
		body = body.replace("## Proposal\n", "## Proposal\nLimit each client IP.\n");
		const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", "livespec:phase/define"] });
		await h.session.refresh();
		expect((await h.call("spec_gate", { target: "define", briefing: BRIEFING })).isError).toBe(false);
		await h.call("spec_status");
		expect((await h.call("plan_units", { units: [unit("Counter", "src/limits/counter.ts", "c"), unit("Readme note", "README.md", "r")] })).isError).toBe(false);

		await useAdapters(h, "forge");
		// In plan, before any plan gate: a spec cascade (seeded) marks U1 stale and the change returns to define.
		await h.world.postComment(n, BOT_LOGIN, writeMarked("stale", "Q1", { reason: "Q1", phases: ["define", "plan", "build", "review", "ship", "close"], units: ["U1"], after_plan: false }));
		await h.world.forge.removeLabels(n, ["livespec:phase/plan"]);
		await h.world.forge.addLabels(n, ["livespec:phase/define"]);
		await h.session.refresh();
		expect(await phaseOf(h, n)).toEqual(["livespec:phase/define"]);
		expect(card(h).state.lock.staleUnits).toContain("U1");

		const define = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(define.isError, textOf(define)).toBe(false);
		await writerSays(h, n, "/livespec approve");
		const plan = await h.call("spec_gate", { target: "plan", briefing: BRIEFING });
		expect(plan.isError, textOf(plan)).toBe(false);
		await writerSays(h, n, "/livespec approve");

		expect(await phaseOf(h, n)).toEqual(["livespec:phase/build"]);
		expect(card(h).state.lock.staleUnits).toEqual([]);
		expect(card(h).step.next).not.toContain("unit_amend");
	});
});

// --- the ship gate's next step (phase-gates "Ship approved", "Waived ship gate stays in ship") ---------

/** A change in `ship` with every unit done, a Durable docs table that covers the committed spec, and no `PR` line. */
async function shipChange(flow?: string): Promise<{ h: ToolHarness; n: number }> {
	const files: Record<string, string> = flow === undefined ? {} : { ".pi/livespec/flow.yaml": flow };
	const h = await toolHarness({ branch: CHANGE_BRANCH, files, ui: { hasUI: true, select: shipSelect } });
	const base = h.git("rev-parse", "HEAD");
	await writeIn(h.root, "specs/rate-limit/spec.md", SPEC);
	commitAll(h.root, "spec");
	const body = replaceSection(allDone(resumeBody(base)), "Durable docs", "| File | Status |\n|---|---|\n| specs/rate-limit/spec.md | updated |").replace(/^PR: .*\n/m, "");
	const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", "livespec:phase/ship"] });
	// The review gate passed at HEAD, so the ship steps do not send the change back to review.
	const review = { phase: "review", outcome: "approved", notes: "", by: "livespec", at: "2026-11-15T10:00:00.000Z", adapter: "livespec", head_sha: h.git("rev-parse", "HEAD"), waivers: [] };
	await h.world.postComment(n, BOT_LOGIN, writeMarked("gate", "review.self-1", review));
	await h.session.refresh();
	return { h, n };
}

/** The in-session human waives when a waive option is offered, else approves. */
const shipSelect: SelectFn = async (title, options) => {
	if (title === "Add notes?") return "No notes";
	return pickById(options, "waive") ?? pickByLabel(options, "approve");
};

describe("ship gate next step", () => {
	test("Ship approved", async () => {
		const { h, n } = await shipChange();
		const out = await h.call("spec_gate", { target: "ship", briefing: BRIEFING });
		expect(out.isError, textOf(out)).toBe(false);
		expect(await phaseOf(h, n)).toEqual(["livespec:phase/ship"]);
		expect(card(h).step.next).toBe("The ship gate is approved: run change_ship.");
		expect(card(h).step.advance).toBeUndefined();
	});

	test("Waived ship gate stays in ship", async () => {
		registerCheck("size-limits", async () => [{ code: "size-limits", severity: "error", message: "U3 touches too many files" }], { waivable: true });
		const { h, n } = await shipChange("extends: agent-skills\nphases:\n  - id: ship\n    checks: [durable-docs, size-limits]\n");
		const out = await h.call("spec_gate", { target: "ship", briefing: BRIEFING });
		expect(out.isError, textOf(out)).toBe(false);
		expect(await phaseOf(h, n)).toEqual(["livespec:phase/ship"]);
		expect(card(h).state.lock.gates.ship?.waivers).toEqual(["size-limits"]);
		expect(card(h).step.next).toBe("The ship gate is approved: run change_ship.");
	});
});
