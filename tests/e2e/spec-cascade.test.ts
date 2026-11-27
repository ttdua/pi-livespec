// End-to-end spec-diff cascade (questions-and-stuck "Spec-diff requirement cascade" and its neighbours): each
// scenario drives a real trigger (`/livespec next`, `spec_gate`, `unit_finish`, session start, `change_sync`)
// over a memory forge and a real git repository, and asserts what a user sees: the phase label, the unit status
// lines, the `stale` comments, `change_iterations`, and the tool's own text. The cascade's git edge cases are
// pinned in tests/interaction/spec-cascade.test.ts; here they only need the trigger.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runNextCommand } from "../../src/commands/next.ts";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { resetGatesForTests } from "../../src/engine/gates.ts";
import { decisionComment } from "../../src/decide/records.ts";
import { registerCheck } from "../../src/engine/registry.ts";
import { ENTRY_LABELS } from "../../src/interaction/menu.ts";
import "../../src/initiatives/facts.ts";
import { REMOVED_DIGEST } from "../../src/engine/requirement-diff.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { createGit } from "../../src/engine/git.ts";
import { BRIEFING } from "../helpers/briefing.ts";
import { pickByLabel } from "../helpers/menu.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import {
	BURST,
	burstBlock,
	CAP,
	type CascadeHarness,
	type CascadeHarnessOptions,
	cascadeHarness,
	seedLock,
	noFaults,
	faultyForge,
	changeBody,
	dataOf,
	doneUnits,
	editSpec,
	GONE_SHA,
	iterations,
	lock,
	mainEdits,
	own,
	phaseOf,
	seedOwn,
	spec,
	SPEC_PATH,
	stales,
	UNITS,
	WINDOW,
} from "../helpers/spec-cascade-fixture.ts";
import type { SelectFn } from "../hooks/fake-pi.ts";
import { CHANGE_BRANCH, cleanupHomes, harness } from "../hooks/helpers.ts";
import { cleanupDirs, textOf, type ToolOut } from "../tools/helpers.ts";

beforeEach(() => registerCheck("verify-red-on-base", async () => [], { waivable: true, at: "gate", key: () => "stub" }));

afterEach(async () => {
	setSession(undefined);
	resetGatesForTests();
	await cleanupDirs();
	await cleanupHomes();
});

const CAP_EDIT = "Each IP SHALL be capped at 100.";
const ANSWER = "per client token";
const DEFINE = ["livespec:phase/define"];
const BUILD = ["livespec:phase/build"];
const PLAN = ["livespec:phase/plan"];

/** The in-session human approves every gate and keeps notes and classification as they are. */
const approveAll: SelectFn = async (title, options) => {
	if (title === "Add notes?") return "No notes";
	if (title === "Adjust Difficulty or Tags?") return "Keep classification";
	return pickByLabel(options, "approve");
};

/** A locked change in `build` (U1..U3 done, U4 pending) with an in-session human that approves. */
async function locked(o: CascadeHarnessOptions = {}): Promise<CascadeHarness> {
	const h = await cascadeHarness({ ui: { hasUI: true, select: approveAll }, ...o });
	await lock(h);
	return h;
}

const ok = (out: ToolOut, what: string): ToolOut => {
	expect(out.isError, `${what}: ${textOf(out)}`).toBeFalsy();
	return out;
};

const next = (h: CascadeHarness): Promise<string> => runNextCommand(h.session);
const nextStep = (h: CascadeHarness): string => {
	const c = h.session.card;
	if (c.kind !== "change") throw new Error(`no change card: ${c.kind}`);
	return c.step.next;
};
const staleUnits = (h: CascadeHarness): string[] => {
	const c = h.session.card;
	return c.kind === "change" ? c.state.lock.staleUnits : [];
};

/** An approved amendment of `unit` at its current digest, as `unit_amend` completes it. */
async function amended(h: CascadeHarness, unit: string): Promise<void> {
	const u = parseChange(await h.world.bodyOf(h.n)).units.find((x) => x.id === unit);
	const digest = u ? unitDigest(u) : "";
	const id = `amend-${unit}-${(await own(h)).length}`;
	await seedOwn(h, "amendment", id, { request: id, action: "edit", unit, old: digest, new: digest, outcome: "approved", by: "alice", at: "2026-11-16T10:00:00.000Z", adapter: "in-session" });
}

describe("spec-diff cascade through the triggers", () => {
	test("Spec edit sends the change back (via /livespec next)", async () => {
		const h = await locked();
		await editSpec(h, CAP_EDIT);
		const out = await next(h);
		expect(await phaseOf(h)).toEqual(DEFINE);
		expect(await doneUnits(h)).toEqual(["U1", "U2"]);
		expect(staleUnits(h)).toEqual(["U3", "U4"]);
		const cascades = await stales(h, "spec.");
		expect(cascades).toHaveLength(1);
		expect(dataOf(cascades[0])).toMatchObject({ units: ["U3", "U4"], after_plan: true, requirements: { [CAP]: expect.any(String) } });
		expect(await iterations(h)).toBe(1);
		expect(await own(h).then((m) => m.filter((x) => x.kind === "request"))).toEqual([]);
		expect(out).not.toContain("spec_question");
	});

	test("Old approval not reused after a cascade: the next step is the define gate again", async () => {
		// No define subagents, so the gate decides the define step.
		const h = await locked({ files: { ".pi/livespec/flow.yaml": "extends: agent-skills\nphases:\n  - id: define\n    subagents: []\n" } });
		// A define gate approved before the lock; the cascade lists define, so the old approval stops counting.
		await seedOwn(h, "gate", "define.self-1", { phase: "define", outcome: "approved", notes: "", by: "alice", at: "2026-11-14T10:00:00.000Z", adapter: "in-session", head_sha: h.head, waivers: [] });
		await editSpec(h, CAP_EDIT);
		const out = await next(h);
		expect(await phaseOf(h)).toEqual(DEFINE);
		expect(out).toContain("Ready for the define gate.");
		expect(nextStep(h)).toBe("Ready for the define gate.");
	});

	test("Edit no done unit covers (via spec_gate build, which refuses)", async () => {
		const h = await locked({ units: [UNITS[0], UNITS[1], { id: "U3", requirement: "Per-IP cap", done: false }, { id: "U4", requirement: "Window", done: false }] });
		await editSpec(h, CAP_EDIT);
		const out = await h.call("spec_gate", { target: "build", briefing: BRIEFING });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("current phase (define)");
		expect(await doneUnits(h)).toEqual(["U1", "U2"]);
		expect(dataOf((await stales(h, "spec."))[0])).toMatchObject({ units: ["U3"], requirements: { [CAP]: expect.any(String) } });
		expect(staleUnits(h)).toEqual(["U3"]);
		expect(await phaseOf(h)).toEqual(DEFINE);
		expect(await own(h).then((m) => m.filter((x) => x.kind === "gate" && x.id.startsWith("build")))).toEqual([]);
	});

	test("Answer in build changes nothing else", async () => {
		const answerNow: SelectFn = async (_title, options) => options.find((o) => o.startsWith(ENTRY_LABELS.answerNow));
		const h = await locked({ ui: { hasUI: true, select: answerNow, input: async () => ANSWER } });
		ok(await h.call("spec_question", { text: "Is the cap per IP or per token?" }), "spec_question");
		const [question] = parseChange(await h.world.bodyOf(h.n)).questions;
		expect(question).toMatchObject({ id: "Q1", checked: true, answer: ANSWER });
		expect(await h.world.bodyOf(h.n)).toContain(`- [x] Q1 (blocking): Is the cap per IP or per token? — Answer: ${ANSWER}`);
		await next(h);
		expect(await doneUnits(h)).toEqual(["U1", "U2", "U3"]);
		expect(await stales(h, "")).toEqual([]);
		expect(await phaseOf(h)).toEqual(BUILD);
	});

	test("Whitespace and moved lines ignored", async () => {
		const h = await locked();
		const reflowed = spec("Each IP\n   SHALL be\n\tcapped.").replace("### Requirement: Per-IP cap", "\n\n### Requirement: Per-IP cap");
		await writeIn(h.root, SPEC_PATH, reflowed);
		commitAll(h.root, "reflow");
		await next(h);
		expect(await stales(h, "")).toEqual([]);
		expect(await doneUnits(h)).toEqual(["U1", "U2", "U3"]);
		expect(await phaseOf(h)).toEqual(BUILD);
	});

	test("Edit before the lock", async () => {
		const h = await cascadeHarness({ phase: "plan" });
		await editSpec(h, CAP_EDIT);
		await next(h);
		expect(await stales(h, "")).toEqual([]);
		expect(await phaseOf(h)).toEqual(PLAN);
	});

	test("Rebased branch on a fresh clone", async () => {
		const h = await cascadeHarness();
		await lock(h, { headSha: GONE_SHA });
		await next(h);
		expect(await stales(h, "")).toEqual([]);
		expect(await phaseOf(h)).toEqual(BUILD);
	});

	test("Edit after a rebase", async () => {
		const h = await cascadeHarness();
		await lock(h, { headSha: GONE_SHA });
		await editSpec(h, CAP_EDIT);
		await next(h);
		expect(dataOf((await stales(h, "spec."))[0])).toMatchObject({ units: ["U3", "U4"], requirements: { [CAP]: expect.any(String) } });
		expect(await doneUnits(h)).toEqual(["U1", "U2"]);
		expect(await phaseOf(h)).toEqual(DEFINE);
	});

	test("Capability covered after the lock", async () => {
		const audit = ["# audit-log", "", "## Requirements", "### Requirement: Retention", "Logs SHALL be kept.", "", "#### Scenario: Kept", "- **WHEN** x", "- **THEN** y", ""].join("\n");
		const h = await locked({ files: { "specs/audit-log/spec.md": audit } });
		// An approved amendment adds U5 covering audit-log; the lock's requirement_scope stays [rate-limit].
		const body = await h.world.bodyOf(h.n);
		const u5 = ["### U5 — Unit U5", "Covers: audit-log/Requirement: Retention", "Difficulty: low", "Tags: []", "Files: src/u5.ts", "Done means:", "- [a] works", "Scenarios:", "- [a] t.test.ts › U5", "Depends: —", "Verify: `true`", "- [x] done", "", ""].join("\n");
		await h.world.editBodyBehindBack(h.n, body.replace("## Durable docs", `${u5}## Durable docs`));
		await amended(h, "U5");
		await writeIn(h.root, "specs/audit-log/spec.md", audit.replace("Logs SHALL be kept.", "Logs SHALL be kept for 30 days."));
		commitAll(h.root, "audit edit");
		await next(h);
		expect(await stales(h, "spec.")).toEqual([]);
		expect(await doneUnits(h)).toContain("U5");
		expect(await phaseOf(h)).toEqual(BUILD);
	});

	test("Hand merge of the integration branch ignored", async () => {
		const h = await locked();
		await mainEdits(h, { [SPEC_PATH]: spec(undefined, "Spikes SHALL be absorbed by main.") });
		h.git("merge", "-q", "--no-edit", "origin/main");
		await next(h);
		expect(await stales(h, "")).toEqual([]);
		expect(await doneUnits(h)).toEqual(["U1", "U2", "U3"]);
		expect(await phaseOf(h)).toEqual(BUILD);
	});

	test("Conflict resolved by combining both sides", async () => {
		const h = await locked();
		await mainEdits(h, { [SPEC_PATH]: spec("Each IP SHALL be capped by main.") });
		await editSpec(h, "Each IP SHALL be capped by the change.");
		expect(() => h.git("merge", "-q", "--no-edit", "origin/main")).toThrow();
		await writeIn(h.root, SPEC_PATH, spec("Each IP SHALL be capped by main and the change."));
		commitAll(h.root, "merge");
		await next(h);
		const cascades = await stales(h, "spec.");
		expect(cascades).toHaveLength(1);
		expect(Object.keys(dataOf(cascades[0]).requirements as object)).toEqual([CAP]);
		expect(await phaseOf(h)).toEqual(DEFINE);
	});

	test("Own edit reverted while main never touched it", async () => {
		const h = await locked();
		await editSpec(h, CAP_EDIT);
		await next(h);
		await editSpec(h);
		await next(h);
		const cascades = await stales(h, "spec.");
		expect(cascades).toHaveLength(2);
		expect(Object.keys(dataOf(cascades[1]).requirements as object)).toEqual([CAP]);
	});

	test("Same edit cascades once", async () => {
		const h = await locked();
		await editSpec(h, CAP_EDIT);
		await next(h);
		await amended(h, "U3");
		await next(h);
		expect(await stales(h, "spec.")).toHaveLength(1);
		expect(staleUnits(h)).not.toContain("U3");
		expect(await iterations(h)).toBe(1);
	});

	test("Further edit of the same requirement", async () => {
		const h = await locked();
		await editSpec(h, CAP_EDIT);
		await next(h);
		await amended(h, "U3");
		await editSpec(h, "Each IP SHALL be capped at 200.");
		await next(h);
		const cascades = await stales(h, "spec.");
		expect(cascades).toHaveLength(2);
		expect(dataOf(cascades[1])).toMatchObject({ units: ["U3", "U4"], requirements: { [CAP]: expect.any(String) } });
		expect(staleUnits(h)).toContain("U3");
	});

	test("Removed requirement cascades once", async () => {
		const h = await locked();
		await writeIn(h.root, SPEC_PATH, spec().replace(burstBlock(), ""));
		commitAll(h.root, "remove Burst");
		await next(h);
		await next(h);
		const cascades = await stales(h, "spec.");
		expect(cascades).toHaveLength(1);
		expect(dataOf(cascades[0])).toMatchObject({ units: ["U2"], requirements: { [BURST]: REMOVED_DIGEST } });
	});

	test("Edit reverted after a cascade", async () => {
		const h = await locked();
		await editSpec(h, CAP_EDIT);
		await next(h);
		const first = dataOf((await stales(h, "spec."))[0]).requirements as Record<string, string>;
		await editSpec(h);
		await next(h);
		const cascades = await stales(h, "spec.");
		expect(cascades).toHaveLength(2);
		const restored = (dataOf(cascades[1]).requirements as Record<string, string>)[CAP];
		expect(restored).toBeDefined();
		expect(restored).not.toBe(first[CAP]);
	});

	test("Second edit while in define", async () => {
		const h = await locked();
		await editSpec(h, CAP_EDIT);
		await next(h);
		expect(await phaseOf(h)).toEqual(DEFINE);
		await editSpec(h, CAP_EDIT, "Spikes SHALL be absorbed.");
		await next(h);
		const cascades = await stales(h, "spec.");
		expect(cascades).toHaveLength(2);
		expect(Object.keys(dataOf(cascades[1]).requirements as object)).toEqual([BURST]);
		expect(await iterations(h)).toBe(1);
	});

	test("Branch switched away: /livespec next writes nothing to the change", async () => {
		const h = await locked();
		h.git("switch", "-q", "-c", "livespec/other");
		await editSpec(h, CAP_EDIT);
		await next(h);
		expect(h.faults.ops).toEqual([]);
		expect(await stales(h, "")).toEqual([]);
		expect(await phaseOf(h)).toEqual(BUILD);
		expect(await doneUnits(h)).toEqual(["U1", "U2", "U3"]);
		expect(h.session.errors.filter((e) => e.startsWith("spec-cascade"))).toEqual([]);
	});

	test("Read-only forge skips the cascade", async () => {
		const h = await locked();
		await editSpec(h, CAP_EDIT);
		await h.world.makeUnreachable();
		await expect(h.forge.listComments(h.n)).rejects.toThrow();
		await h.world.restore();
		expect(h.forge.isReadOnly()).toBe(true);
		const out = await next(h);
		expect(out).toContain("Next: <untrusted>Build U4 — Unit U4.</untrusted>");
		expect(h.faults.ops).toEqual([]);
		expect(await stales(h, "")).toEqual([]);
		expect(await phaseOf(h)).toEqual(BUILD);
	});
});

// --- other triggers -------------------------------------------------------------------------------------

/** A flow whose define and plan phases dispatch no subagent, so the gate decides their next step. */
const NO_GATE_SUBAGENTS = "extends: agent-skills\nphases:\n  - id: define\n    subagents: []\n  - id: plan\n    subagents: []\n";
const FLOW = { ".pi/livespec/flow.yaml": NO_GATE_SUBAGENTS };

/** U2 (Burst) pending and red at HEAD, so `unit_start U2` records a start. */
const U2_PENDING = [UNITS[0], { id: "U2", requirement: "Burst", done: false, verify: "test -f src/u2.ts" }, UNITS[2], UNITS[3]];

/** A gate approved behind the session's back (another session or the forge), after every comment so far. */
async function approvedGate(h: CascadeHarness, phase: string): Promise<void> {
	const id = `${phase}.seed-${(await own(h)).length}`;
	await seedOwn(h, "gate", id, { phase, outcome: "approved", notes: "", by: "alice", at: "2026-11-16T10:00:00.000Z", adapter: "in-session", head_sha: h.git("rev-parse", "HEAD"), waivers: [] });
}

/** Kind and id of every own comment written after `before`, in order. */
async function newComments(h: CascadeHarness, before: { commentId: string }[]): Promise<[string, string | undefined][]> {
	const seen = new Set(before.map((m) => m.commentId));
	return (await own(h)).filter((m) => !seen.has(m.commentId)).map((m) => [m.kind, m.id]);
}

async function movePhase(h: CascadeHarness, from: string, to: string): Promise<void> {
	await h.world.forge.removeLabels(h.n, [`livespec:phase/${from}`]);
	await h.world.forge.addLabels(h.n, [`livespec:phase/${to}`]);
	await h.session.refresh();
}

/** The change's own spec diff from Base, so the define phase has its `specs-diff` output and checks pass. */
async function ownSpecDiff(h: CascadeHarness): Promise<void> {
	await writeIn(h.root, SPEC_PATH, spec().replace("The window SHALL slide.", "The window SHALL slide by the second."));
	commitAll(h.root, "own spec edit");
}

describe("spec-diff cascade through other triggers", () => {
	test("Edit merged by change_sync ignored", async () => {
		const h = await cascadeHarness({ header: ["Initiative: #2"] });
		await h.world.seedIssue({ title: "limits", body: `Goal: Limit\nCapabilities: [rate-limit]\n\n## Changes\n- [x] #9 audit-log — Depends: —\n- [ ] #${h.n} per-ip-cap — Depends: —\n`, labels: ["livespec:initiative"] });
		await lock(h);
		await mainEdits(h, { [SPEC_PATH]: spec(undefined, "Spikes SHALL be absorbed by the sibling.") });
		await h.session.refresh();
		ok(await h.call("change_sync"), "change_sync");
		expect(h.git("merge-base", "--is-ancestor", "origin/main", "HEAD")).toBe("");
		const before = await own(h);
		await next(h);
		// change_sync's own base diff may stale the units it covers (`stale.sync.*`); the cascade adds nothing.
		expect(await stales(h, "spec.")).toEqual([]);
		expect(await own(h)).toHaveLength(before.length);
		expect(await iterations(h)).toBe(0);
		expect(await phaseOf(h)).toEqual(BUILD);
	});

	test("Retried cascade counts once (via session_start)", async () => {
		// The hooks harness: an https origin and a fake account, so session_start connects the forge.
		const faults = noFaults();
		const h = await harness({ branch: CHANGE_BRANCH, files: { [SPEC_PATH]: spec() }, forge: (world) => faultyForge(world.forge, faults) });
		const n = await h.world.seedIssue({ title: "per-ip-cap", body: `Base: ${h.head}\nBranch: ${CHANGE_BRANCH}\n${changeBody()}`, labels: ["livespec", "livespec:phase/build"] });
		await seedLock(h.world, n, createGit(h.root));
		await writeIn(h.root, SPEC_PATH, spec(CAP_EDIT));
		commitAll(h.root, "spec edit");
		const view = { world: h.world, n } as unknown as CascadeHarness;
		// The first start writes the stale comment, then the untick conflicts.
		faults.conflictOnce = true;
		await h.start();
		expect(await stales(view, "spec.")).toHaveLength(1);
		expect(await phaseOf(view)).toEqual(BUILD);
		// The next session start runs the cascade again and completes it.
		await h.start();
		expect(await doneUnits(view)).toEqual(["U1", "U2"]);
		expect(await phaseOf(view)).toEqual(DEFINE);
		expect(await stales(view, "spec.")).toHaveLength(1);
		expect(await iterations(view)).toBe(1);
	});

	test("Baseline commit missing (via unit_finish U2)", async () => {
		const h = await cascadeHarness({ units: U2_PENDING, files: FLOW });
		await ownSpecDiff(h);
		await lock(h, { headSha: GONE_SHA, legacy: true });
		ok(await h.call("unit_start", { unit: "U2" }), "unit_start U2");
		const before = await own(h);
		const out = await h.call("unit_finish", { unit: "U2" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("not in a per: unit phase (phase define)");
		const records = await stales(h, "baseline.");
		expect(records).toHaveLength(1);
		expect(records[0]?.id).toBe(`baseline.${GONE_SHA.slice(0, 12)}`);
		// unit_finish refused and wrote nothing of its own: the only new comment is the cascade's.
		expect(await newComments(h, before)).toEqual([["stale", records[0]?.id]]);
		expect(await doneUnits(h)).toEqual(["U1", "U3"]);
		expect(await phaseOf(h)).toEqual(DEFINE);
		expect(nextStep(h)).toBe("Ready for the define gate.");
		expect(await iterations(h)).toBe(0);
	});

	test("Missing baseline handled once", async () => {
		const h = await cascadeHarness({ files: FLOW });
		await lock(h, { headSha: GONE_SHA, legacy: true });
		await next(h);
		expect(await phaseOf(h)).toEqual(DEFINE);
		await approvedGate(h, "define");
		await movePhase(h, "define", "plan");
		await next(h);
		expect(await stales(h, "baseline.")).toHaveLength(1);
		expect(await phaseOf(h)).toEqual(PLAN);
	});

	test("Baseline commit missing in define", async () => {
		const h = await cascadeHarness({ phase: "define", files: FLOW });
		await lock(h, { headSha: GONE_SHA, legacy: true });
		await next(h);
		const records = await stales(h, "baseline.");
		expect(records).toHaveLength(1);
		expect(dataOf(records[0])).toMatchObject({ units: [], after_plan: false });
		expect(await phaseOf(h)).toEqual(DEFINE);
		await approvedGate(h, "define");
		await movePhase(h, "define", "plan");
		await next(h);
		expect(await stales(h, "baseline.")).toHaveLength(1);
		expect(await phaseOf(h)).toEqual(PLAN);
	});

	test("Parallel triggers run once (spec_gate build and unit_finish U2)", async () => {
		const h = await locked({ units: U2_PENDING });
		ok(await h.call("unit_start", { unit: "U2" }), "unit_start U2");
		await editSpec(h, CAP_EDIT);
		const before = await own(h);
		const [gate, finish] = await Promise.all([h.call("spec_gate", { target: "build", briefing: BRIEFING }), h.call("unit_finish", { unit: "U2" })]);
		expect(gate.isError).toBe(true);
		expect(finish.isError).toBe(true);
		const cascades = await stales(h, "spec.");
		expect(cascades).toHaveLength(1);
		// Neither tool wrote a comment of its own (no gate, receipt or progress): only the cascade's stale.
		expect(await newComments(h, before)).toEqual([["stale", cascades[0]?.id]]);
		expect(await iterations(h)).toBe(1);
		expect(await phaseOf(h)).toEqual(DEFINE);
	});
});

// The re-approval needs the real define and plan gates, so the new plan gate comment is livespec's own.
describe("unit-planning re-approval", () => {
	test("Re-approval after a missing baseline", async () => {
		const h = await cascadeHarness({ files: FLOW, ui: { hasUI: true, select: approveAll } });
		await ownSpecDiff(h);
		await lock(h, { headSha: GONE_SHA, legacy: true });
		await next(h);
		expect(await phaseOf(h)).toEqual(DEFINE);
		expect(staleUnits(h)).toEqual([]);

		ok(await h.call("spec_gate", { target: "define", briefing: BRIEFING }), "spec_gate define");
		await next(h);
		expect(await phaseOf(h)).toEqual(PLAN);
		await seedClassification(h);
		ok(await h.call("spec_gate", { target: "plan", briefing: BRIEFING }), "spec_gate plan");
		const plan = (await own(h)).filter((m) => m.kind === "gate" && dataOf(m).phase === "plan").at(-1);
		expect(dataOf(plan)).toMatchObject({ outcome: "approved", requirement_scope: ["rate-limit"], requirements: { [CAP]: expect.any(String), [BURST]: expect.any(String), [WINDOW]: expect.any(String) } });
		await next(h);

		// The new record is the baseline: an edit after it cascades, and nothing before it does.
		await editSpec(h, CAP_EDIT);
		await next(h);
		const cascades = await stales(h, "spec.");
		expect(cascades).toHaveLength(1);
		expect(Object.keys(dataOf(cascades[0]).requirements as object)).toEqual([CAP]);
		expect(await stales(h, "baseline.")).toHaveLength(1);
	});
});

/** Rule decision records for every unit, so `unit-classification` passes at the plan gate. */
async function seedClassification(h: CascadeHarness): Promise<void> {
	for (const u of parseChange(await h.world.bodyOf(h.n)).units) {
		const digest = unitDigest(u);
		await h.world.postComment(h.n, BOT_LOGIN, decisionComment({ point: "tags", subject: u.id, digest, source: "rule", outcome: u.tags, reason: "rule" }));
		await h.world.postComment(h.n, BOT_LOGIN, decisionComment({ point: "difficulty", subject: u.id, digest, source: "rule", outcome: u.difficulty, reason: "rule" }));
	}
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
}
