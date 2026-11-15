// End-to-end gate flow over a memory forge: every human decision of LS-05
// goes through the real tools, the approver chain and forge polling.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { parseChange } from "../../src/core/change.ts";
import { setHeaderLine } from "../../src/core/sections.ts";
import type { UnitInput } from "../../src/core/unit-blocks.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { CHANGE_BODY_TEMPLATE } from "../../src/tools/change-new.ts";
import type { SelectFn } from "../hooks/fake-pi.ts";
import { CHANGE_BRANCH } from "../hooks/helpers.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "../tools/helpers.ts";

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
		{ id: "A", label: "split the change" },
		{ id: "B", label: "keep going" },
	],
	recommended: "A",
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
	return options.find((o) => o === "approve");
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
		body = body.replace("## Proposal\n", "## Proposal\nLimit each client IP.\n");
		const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", "livespec:phase/define"] });
		await h.session.refresh();

		// 2. The define gate, approved in session.
		const define = await h.call("spec_gate", { target: "define" });
		expect(define.isError, textOf(define)).toBe(false);
		await h.call("spec_status");
		expect(await phaseOf(h, n)).toEqual(["livespec:phase/plan"]);

		// 3. Units.
		const planned = await h.call("plan_units", { units: [unit("Counter", "src/limits/counter.ts", "c"), unit("Readme note", "README.md", "r")] });
		expect(planned.isError, textOf(planned)).toBe(false);

		// 4. The plan gate over the forge, approved by a writer's command.
		await useAdapters(h, "forge");
		const plan = await h.call("spec_gate", { target: "plan" });
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

		// 7. A question answered with a requirement change that U1 covers.
		const asked = await h.call("spec_question", { text: "Is the cap per IP or per token?" });
		expect(asked.isError, textOf(asked)).toBe(false);
		await writerSays(h, n, `/livespec answer Q1 per client token --changes ${PER_IP}`);

		expect(await phaseOf(h, n)).toEqual(["livespec:phase/define"]);
		expect(parseChange(await h.world.bodyOf(n)).units.find((u) => u.id === "U1")?.done).toBe(false);
		expect(card(h).state.lock.staleUnits).toContain("U1");
		expect(card(h).state.counters.change_iterations).toBe(1);

		const capped = await h.call("spec_gate", { target: "define" });
		expect(capped.isError).toBe(true);
		expect(textOf(capped)).toContain("spec_stuck");

		const stuck = await h.call("spec_stuck", STUCK);
		expect(stuck.isError, textOf(stuck)).toBe(false);
		await writerSays(h, n, "/livespec choose A");
		expect(card(h).state.iterations.blocking).toBe(false);
		expect(card(h).step.next).not.toContain("spec_stuck");
		const reopened = await h.call("spec_gate", { target: "define" });
		expect(reopened.isError, textOf(reopened)).toBe(false);
	});
});
