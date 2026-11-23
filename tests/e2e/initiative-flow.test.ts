// End-to-end initiative and discovered-dependency flows (issue #34 "Done when"): every human decision goes through
// the real tools and an in-session approver over a memory forge with a real bare origin.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import "../../src/initiatives/facts.ts";
import { parseChange } from "../../src/core/change.ts";
import { parseInitiative } from "../../src/core/initiative.ts";
import { setHeaderLine } from "../../src/core/sections.ts";
import type { UnitInput } from "../../src/core/unit-blocks.ts";
import { resetGatesForTests } from "../../src/engine/gates.ts";
import { registerCheck } from "../../src/engine/registry.ts";
import { filterMarked, type MarkedComment } from "../../src/forge/markers.ts";
import type { Issue } from "../../src/forge/types.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { registerSizeLimits } from "../../src/initiatives/size-limits.ts";
import { CHANGE_BODY_TEMPLATE } from "../../src/tools/change-new.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import type { FakeUI, SelectFn } from "../hooks/fake-pi.ts";
import { CHANGE_BRANCH } from "../hooks/helpers.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "../tools/helpers.ts";
import { parkHarness, wip } from "../tools/park-fixture.ts";
import { DEFAULT_SKILLS, makeTree } from "../subagents/packet-world.ts";
import { done } from "../subagents/fake-executor.ts";
import { footerIds } from "../tools/subagent-helpers.ts";

beforeEach(() => {
	// The real check needs a worktree run per unit; these flows are about the gates, so it reports nothing.
	registerCheck("verify-red-on-base", async () => [], { waivable: true, at: "gate", key: () => "stub" });
	registerSizeLimits();
});

afterEach(async () => {
	setSession(undefined);
	resetGatesForTests();
	await cleanupDirs();
});

const SPEC = readFileSync(new URL("../fixtures/rate-limit.spec.md", import.meta.url), "utf8");
const PER_IP = "rate-limit/Requirement: Per-IP cap";
const SHAPE_BODY = "Depends: —\nCapabilities: new [], modified []\nProduct impact: —\n\n## Proposal\nCap each IP.\n\n## Design\n\n## Questions\n\n## Units\n\n## Durable docs\n";

/** An in-session human who picks `pick.current` (an option or `approve`) at each gate summary and adds no notes. */
function human(pick: { current: string }): FakeUI {
	const select: SelectFn = async (title, options) => {
		if (title === "Add notes?") return "No notes";
		if (title === "Adjust Difficulty or Tags?") return "Keep classification";
		return options.find((o) => o === pick.current || o.endsWith(`[${pick.current}]`));
	};
	return { hasUI: true, select };
}

function card(h: ToolHarness) {
	const c = h.session.card;
	if (c.kind !== "change") throw new Error(`no change card: ${c.kind}`);
	return c;
}

const marked = async (h: ToolHarness, n = h.n): Promise<MarkedComment[]> => filterMarked(await h.world.forge.listComments(n), BOT_LOGIN).comments;
const latestGate = async (h: ToolHarness) => (await marked(h)).filter((m) => m.kind === "gate").at(-1)?.data as Record<string, unknown> | undefined;
const phaseOf = async (h: ToolHarness, n = h.n) => (await h.world.forge.getIssue(n)).labels.filter((l) => l.startsWith("livespec:phase/"));
const allIssues = (h: ToolHarness) => h.world.forge.searchIssues({ state: "all" });

async function titled(h: ToolHarness, title: string): Promise<Issue> {
	const found = (await allIssues(h)).filter((i) => i.title === title);
	expect(found).toHaveLength(1);
	return found[0] as Issue;
}

function ok(out: { isError?: boolean; content: { text: string }[] }, what: string): void {
	expect(out.isError, `${what}: ${out.content.map((c) => c.text).join("\n")}`).toBeFalsy();
}

// --- plan over the limits ------------------------------------------------------------------------

function unit(i: number): UnitInput {
	const label = `u${i}`;
	return { title: `Part ${i}`, covers: [PER_IP], files: [`src/part${i}.ts`], done_means: [{ label, text: `part ${i} works` }], scenarios: [{ label, ref: `test/${label}.test.ts › part ${i}` }], depends: [], verify: `bun test ${label}` };
}

/** A change in plan with a committed spec diff and `count` units written by `plan_units`. */
async function plannedChange(pick: { current: string }, count: number): Promise<ToolHarness> {
	const h = await toolHarness({ branch: CHANGE_BRANCH, ui: human(pick) });
	h.git("config", `branch.${CHANGE_BRANCH}.livespecBase`, h.head);
	await writeIn(h.root, "specs/rate-limit/spec.md", SPEC);
	commitAll(h.root, "spec");
	let body = setHeaderLine(setHeaderLine(CHANGE_BODY_TEMPLATE, "Base", h.head), "Branch", CHANGE_BRANCH);
	body = body.replace("Capabilities: new [], modified []", "Capabilities: new [rate-limit], modified []").replace("## Proposal\n", "## Proposal\nLimit each client IP.\n");
	const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", "livespec:phase/plan"] });
	await h.session.refresh();
	ok(await h.call("plan_units", { units: Array.from({ length: count }, (_, i) => unit(i + 1)) }), "plan_units");
	expect(parseChange(await h.world.bodyOf(n)).units).toHaveLength(count);
	return { ...h, n };
}

// --- the flows -----------------------------------------------------------------------------------

describe("initiatives and discovered dependencies", () => {
	test("plan over the limits needs a split or a waiver", async () => {
		// An approval cannot be given while a waivable check fails; the completion-superseded path is covered by
		// tests/interaction/complete.test.ts and tests/tools/spec-gate.test.ts "Over the unit limit".
		// Nine units exceed max_units 8: the human is not offered approve, and the gate does not pass.
		const pick = { current: "approve" };
		const h = await plannedChange(pick, 9);
		ok(await h.call("spec_gate", { target: "plan" }), "plan gate over the limits");
		const offered = (h.ctx.ui.select.mock.calls[0]?.[1] ?? []) as string[];
		expect(offered).not.toContain("approve");
		expect(offered.some((o) => o.endsWith("[waive]") || o === "waive")).toBe(true);
		expect(await latestGate(h)).toMatchObject({ phase: "plan", outcome: "dismissed" });
		expect(await phaseOf(h)).toEqual(["livespec:phase/plan"]);

		// change_split moves U9 into a new change; eight units remain and the plan gate is approved.
		ok(await h.call("change_split", { issue: h.n, units: ["U9"], into: "per-ip-cap-extra" }), "change_split");
		expect(parseChange(await h.world.bodyOf(h.n)).units.map((u) => u.id)).toEqual(["U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8"]);
		const split = await titled(h, "per-ip-cap-extra");
		expect(parseChange(split.body).units.map((u) => u.title)).toEqual(["Part 9"]);
		ok(await h.call("spec_gate", { target: "plan" }), "plan gate within the limits");
		expect(await latestGate(h)).toMatchObject({ phase: "plan", outcome: "approved", waivers: [] });
		expect(await phaseOf(h)).toEqual(["livespec:phase/build"]);

		// Separately, a human waives size-limits for another nine-unit plan.
		const waived = await plannedChange({ current: "waive" }, 9);
		ok(await waived.call("spec_gate", { target: "plan" }), "plan gate waived");
		expect(await latestGate(waived)).toMatchObject({ phase: "plan", outcome: "approved", choice: "waive", waivers: ["size-limits"] });
		expect(await phaseOf(waived)).toEqual(["livespec:phase/build"]);
		expect(parseChange(await waived.world.bodyOf(waived.n)).units).toHaveLength(9);
	});

	test("change B cannot start before change A merges", async () => {
		// A is the current change per-ip-cap in shape; it proposes an initiative where B (audit-log) depends on it.
		const h = await toolHarness({ change: { body: SHAPE_BODY, phase: "shape" }, ui: human({ current: "approve" }) });
		const proposed = await h.call("initiative_propose", {
			name: "limits",
			goal: "Limit requests",
			capabilities: ["rate-limit"],
			entries: [
				{ name: "per-ip-cap", proposal: "Cap each IP at 100 rps.", depends: [] },
				{ name: "audit-log", proposal: "Log each refusal.", depends: ["per-ip-cap"] },
			],
		});
		ok(proposed, "initiative_propose");
		expect(await latestGate(h)).toMatchObject({ gate: "initiative", outcome: "approved" });
		const b = await titled(h, "audit-log");
		const tracking = await titled(h, "limits");
		expect(parseChange(b.body).header.depends).toEqual([`#${h.n}`]);

		const refused = await h.call("change_start", { issue: b.number });
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain(`#${h.n} open`);
		expect(h.git("branch", "--list", "livespec/audit-log")).toBe("");

		// A human merges A's pull request; change_close closes A and ticks it in the initiative.
		const pr = await h.world.seedPullRequest({ head: CHANGE_BRANCH, state: "closed", merged: true });
		await h.world.editBodyBehindBack(h.n, (await h.world.bodyOf(h.n)).replace(/^Branch:/m, `PR: #${pr}\nBranch:`));
		await h.world.forge.removeLabels(h.n, ["livespec:phase/shape"]);
		await h.world.forge.addLabels(h.n, ["livespec:phase/close"]);
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		ok(await h.call("change_close", {}), "change_close A");
		expect((await h.world.forge.getIssue(h.n)).state).toBe("closed");
		expect(parseInitiative(await h.world.bodyOf(tracking.number)).changes.map((c) => [c.name, c.checked])).toEqual([
			["per-ip-cap", true],
			["audit-log", false],
		]);

		const started = await h.call("change_start", { issue: b.number });
		ok(started, "change_start B");
		expect(h.git("branch", "--show-current")).toBe("livespec/audit-log");
		expect(parseChange(await h.world.bodyOf(b.number)).header.branch).toBe("livespec/audit-log");
	});

	test("parked change with two lanes resumes with no lost work", async () => {
		// U1 done, U4 started in the change worktree, U2 and U3 started in worktree lanes; no prerequisite yet.
		const h = await parkHarness({ choice: null, seedPrereq: false, ui: human({ current: "A" }), extraFiles: { "specs/rate-limit/spec.md": SPEC } });
		h.session.activeTree = makeTree([...DEFAULT_SKILLS]);

		// U3's implementer, run inline, reports a missing prerequisite; the result names new_dependency.
		const packet = textOf(await h.call("subagent_packet", { role: "implementer", unit: "U3" }));
		const result = done({ status: "BLOCKED", reason: "missing-prerequisite", evidence: "U3 needs a token store", commits: [], sources_used: footerIds(packet) });
		const recorded = await h.call("subagent_record", { role: "implementer", unit: "U3", result });
		ok(recorded, "subagent_record");
		expect(textOf(recorded)).toContain("new_dependency U3");

		// The human chooses A: the prerequisite token-store is created and added to Depends.
		ok(
			await h.call("new_dependency", {
				unit: "U3",
				evidence: "U3 needs a token store",
				a: { name: "token-store", proposal: "Store tokens.", depends: [] },
				b: { units: ["U5"], summary: "Add a token store unit." },
				c: { summary: "Stub the store.", follow_up: { name: "token-store-later", proposal: "Persist tokens." } },
				d: { action: "shape", reason: "the design missed the store" },
			}),
			"new_dependency",
		);
		expect(await latestGate(h)).toMatchObject({ gate: "new-dependency", outcome: "approved", choice: "A" });
		const prereq = await titled(h, "token-store");
		expect(parseChange(await h.world.bodyOf(h.n)).header.depends).toEqual([`#${prereq.number}`]);

		// U2's lane holds a commit, U3's lane an uncommitted edit; change_park keeps both on wip branches.
		await writeIn(h.lanes.U2.path, "src/u2.ts", "u2 partial\n");
		h.lanes.U2.git("add", "-A");
		h.lanes.U2.git("commit", "-q", "-m", "U2 partial");
		await writeIn(h.lanes.U3.path, "src/u3.ts", "u3 edit\n");
		ok(await h.park(), "change_park");
		expect((await h.world.forge.getIssue(h.n)).labels).toContain("livespec:parked");
		expect(h.git("ls-remote", "origin", `refs/heads/${wip("U2")}`)).not.toBe("");
		expect(h.git("ls-remote", "origin", `refs/heads/${wip("U3")}`)).not.toBe("");

		// Resume is refused until the prerequisite merges; then both lanes' work is in HEAD.
		expect((await h.resume()).isError).toBe(true);
		await h.mergePrereq({ "other.txt": "o\n" }, prereq.number);
		const tip = h.git("rev-parse", "origin/main");
		ok(await h.resume(), "change_resume");
		for (const u of ["U2", "U3"]) expect(h.git("ls-remote", "origin", `refs/heads/${wip(u)}`)).toBe("");
		expect(h.git("merge-base", "--is-ancestor", tip, "HEAD")).toBe("");
		expect(h.git("show", "HEAD:src/u2.ts")).toBe("u2 partial");
		expect(h.git("show", "HEAD:src/u3.ts")).toBe("u3 edit");
		expect((await h.world.forge.getIssue(h.n)).labels).not.toContain("livespec:parked");
		await h.session.refresh();
		expect(card(h).state.parkedCore).toBeUndefined();
	});

	test("Depends cycle is rejected", async () => {
		const h = await toolHarness({ change: { body: SHAPE_BODY, phase: "shape" }, ui: human({ current: "approve" }) });
		const before = (await allIssues(h)).length;
		const out = await h.call("initiative_propose", {
			name: "limits",
			goal: "Limit requests",
			capabilities: ["rate-limit"],
			entries: [
				{ name: "token-store", proposal: "Store tokens.", depends: ["audit-log"] },
				{ name: "audit-log", proposal: "Log refusals.", depends: ["per-ip-cap"] },
				{ name: "per-ip-cap", proposal: "Cap each IP.", depends: ["token-store"] },
			],
		});
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(`#${h.n} → token-store → audit-log → #${h.n}`);
		expect(h.ctx.ui.select).not.toHaveBeenCalled();
		expect((await marked(h)).filter((m) => m.kind === "request" || m.kind === "gate")).toEqual([]);
		expect((await allIssues(h)).length).toBe(before);
	});
});
