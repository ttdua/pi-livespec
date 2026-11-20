// End-to-end build with subagents (issue #7 "Done when"): a driver follows the phase card through the real tools, a fake executor plays the children.

import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { setSession } from "../../src/hooks/session-store.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { done, type Spawned, unpublish } from "../subagents/fake-executor.ts";
import { cleanupDirs, textOf, type ToolOut } from "../tools/helpers.ts";
import { footerIds, type SubagentHarness, subagentHarness } from "../tools/subagent-helpers.ts";
import { cardState, type UnitSpec } from "../tools/unit-helpers.ts";

afterEach(async () => {
	unpublish();
	setSession(undefined);
	await cleanupDirs();
});

const IDS = ["U1", "U2", "U3", "U4", "U5"];
const SCRIPTS = Object.fromEntries(IDS.map((id) => [`check${id.slice(1)}.sh`, `test -f src/${id.toLowerCase()}.ts\n`]));
const unit = (id: string, difficulty: string, depends: string[] = []): UnitSpec => ({ id, verify: `sh check${id.slice(1)}.sh`, difficulty, depends });
/** U1–U3 independent, U4 and U5 wait on U1: two waves of lanes. */
const FIVE = [unit("U1", "medium"), unit("U2", "medium"), unit("U3", "medium"), unit("U4", "medium", ["U1"]), unit("U5", "medium", ["U1"])];

/** What a child (or the parent working inline) does for one run, given the cwd it works in. */
type Work = (role: string, unitId: string, cwd: string, prompt: string) => Promise<Record<string, unknown>>;

/** The default work: the implementer writes and commits its unit's file; the reviewer finds nothing. Both cite every packet source. */
const honest: Work = async (role, unitId, cwd, prompt) => {
	const sources_used = footerIds(prompt);
	if (role !== "implementer") return { status: "DONE", notes: "clean", discoveries: [], sources_used, findings: [] };
	await writeIn(cwd, `src/${unitId.toLowerCase()}.ts`, `export const ${unitId.toLowerCase()} = 1;\n`);
	commitAll(cwd, `implement ${unitId}`);
	return done({ sources_used });
};

/** Makes the fake executor's children run `work` in the spawn's cwd. */
function playChildren(h: SubagentHarness, work: Work): void {
	h.fake.service.wait = async (id: string) => {
		const spawn = h.fake.spawned.find((s) => s.id === id) as Spawned;
		const result = await work(spawn.options.metadata.role ?? spawn.type, spawn.options.metadata.unit ?? "", spawn.options.cwd, spawn.prompt);
		return { id, status: "completed", structuredResult: JSON.parse(JSON.stringify(result)) };
	};
}

const ok = (out: ToolOut, what: string): ToolOut => {
	if (out.isError) throw new Error(`${what}: ${textOf(out)}`);
	return out;
};

/** The working directory of `unitId`: its open lane, else the change worktree. */
const cwdOf = (h: SubagentHarness, unitId: string): string => cardState(h).state.subagents.lanes[unitId]?.path ?? h.root;

/** One action per card step; `allow` lists tool calls whose refusal is expected (and logged). */
async function act(h: SubagentHarness, work: Work, log: string[], allow: string[]): Promise<void> {
	const { step } = cardState(h);
	const call = async (tool: string, params: Record<string, unknown>, label: string): Promise<ToolOut> => {
		const out = await h.call(tool, params);
		log.push(out.isError ? `${label} refused` : label);
		return out.isError && allow.includes(label) ? out : ok(out, label);
	};
	const lanes = /^Run these units in parallel lanes: (.+)\.$/.exec(step.next);
	if (lanes) {
		for (const id of (lanes[1] ?? "").split(", ").map((s) => s.replace("lane_open ", ""))) await call("lane_open", { unit: id }, `lane_open ${id}`);
		return;
	}
	const start = /^(?:Start (U\d+) in its lane|Build (U\d+))/.exec(step.next);
	if (start) {
		const id = (start[1] ?? start[2]) as string;
		await call("unit_start", { unit: id }, `unit_start ${id}`);
		return;
	}
	const merge = /lane_merge (U\d+)/.exec(step.next);
	if (merge && step.dispatch === undefined) {
		await call("lane_merge", { unit: merge[1] }, `lane_merge ${merge[1]}`);
		return;
	}
	if (step.dispatch !== undefined) {
		const { role, unit: id, subject, inline } = step.dispatch;
		const target = { role, unit: id, ...(subject === undefined ? {} : { subject }) };
		const label = [role, id, subject].filter(Boolean).join(" ");
		if (!inline) {
			await call("subagent_dispatch", target, `subagent_dispatch ${label}`);
			return;
		}
		const packet = textOf(ok(await h.call("subagent_packet", target), `subagent_packet ${label}`));
		const result = await work(role, id ?? "", cwdOf(h, id ?? ""), packet);
		await h.session.refresh();
		await call("subagent_record", { ...target, result: JSON.parse(JSON.stringify(result)) }, `subagent_record ${label}`);
		return;
	}
	const finish = /^Finish (U\d+) with unit_finish/.exec(step.next);
	if (finish) {
		await call("unit_finish", { unit: finish[1] }, `unit_finish ${finish[1]}`);
		return;
	}
	throw new Error(`the driver does not know the step: ${step.next}`);
}

/** Follows the card until every unit is ticked (or `until` holds); returns the action log. */
async function drive(h: SubagentHarness, o: { work?: Work; allow?: string[]; until?: () => Promise<boolean>; log?: string[] } = {}): Promise<string[]> {
	const log = o.log ?? [];
	const finished = async () => (await h.units()).every((u) => u.done);
	for (let i = 0; i < 120; i++) {
		if ((await finished()) || (o.until !== undefined && (await o.until()))) return log;
		await act(h, o.work ?? honest, log, o.allow ?? []);
	}
	throw new Error(`build did not finish; last step: ${cardState(h).step.next}\n${log.join("\n")}`);
}

const ticked = async (h: SubagentHarness) => (await h.units()).filter((u) => u.done).map((u) => u.id);
const dataOf = async (h: SubagentHarness, kind: string) => (await h.ofKind(kind)).map((m) => m.data as Record<string, unknown>);

describe("issue #7: build with subagents", () => {
	test("five units complete with dispatches and lanes", async () => {
		const h = await subagentHarness({ units: FIVE, scripts: SCRIPTS, executor: {} });
		playChildren(h, honest);
		let parallel = 0;
		const log: string[] = [];
		await drive(h, {
			log,
			until: async () => {
				parallel = Math.max(parallel, Object.keys(cardState(h).state.subagents.lanes).length);
				return false;
			},
		});
		expect(await ticked(h)).toEqual(IDS);
		expect(parallel).toBe(3);
		for (const id of IDS) {
			for (const action of [`lane_open ${id}`, `unit_start ${id}`, `subagent_dispatch implementer ${id}`, `subagent_dispatch reviewer ${id} unit`, `lane_merge ${id}`, `unit_finish ${id}`]) expect(log).toContain(action);
		}
		// The first wave opens three lanes before any unit starts.
		expect(log.slice(0, 3)).toEqual(["lane_open U1", "lane_open U2", "lane_open U3"]);
		const implementers = h.fake.spawned.filter((s) => s.type === "implementer");
		expect(implementers.map((s) => s.options.cwd)).toEqual(IDS.map((id) => join(h.root, ".worktrees", `per-ip-cap--${id}`)));
		expect((await dataOf(h, "dispatch")).filter((d) => d.status === "DONE").map((d) => d.unit)).toEqual(IDS);
		expect((await dataOf(h, "finding-summary")).map((d) => [d.unit, d.completed])).toEqual(IDS.map((id) => [id, true]));
		const closes = (await dataOf(h, "lane")).filter((d) => d.closed === true);
		expect(closes.map((d) => [d.unit, d.outcome])).toEqual(IDS.map((id) => [id, "merged"]));
		expect(h.git("rev-list", "--merges", "--count", "HEAD")).toBe("5");
		expect((await dataOf(h, "receipt")).map((r) => r.unit)).toEqual(IDS);
	});

	test("context threshold moves next unit to a subagent", async () => {
		const units = [unit("U1", "low"), unit("U2", "low", ["U1"])];
		const h = await subagentHarness({ units, scripts: SCRIPTS, executor: {} });
		playChildren(h, honest);
		await drive(h, { until: async () => (await ticked(h)).includes("U1") });
		expect(h.fake.spawned).toEqual([]);
		ok(await h.start("U2"), "unit_start U2");
		expect(cardState(h).step.dispatch).toEqual({ role: "implementer", unit: "U2", inline: true });
		// The main session completes a turn at 59% (the 60% threshold less the 2-point margin holds).
		await h.pi.fire("turn_end", { type: "turn_end" }, { ...h.ctx, getContextUsage: () => ({ tokens: 59, contextWindow: 100, percent: 59 }) });
		await h.session.refresh();
		expect(cardState(h).step.dispatch).toEqual({ role: "implementer", unit: "U2", inline: false });
		await drive(h);
		expect(await ticked(h)).toEqual(["U1", "U2"]);
		expect(h.fake.spawned.map((s) => [s.type, s.options.metadata.unit])).toEqual([["implementer", "U2"]]);
		const records = await dataOf(h, "dispatch");
		expect(records.map((d) => [d.unit, d.agentSource])).toEqual([["U1", "inline"], ["U2", "builtin"]]);
	});

	test("same change completes inline without executor", async () => {
		const h = await subagentHarness({ units: FIVE, scripts: SCRIPTS });
		const log = await drive(h);
		expect(await ticked(h)).toEqual(IDS);
		expect(log.some((a) => a.startsWith("lane_open") || a.startsWith("subagent_dispatch"))).toBe(false);
		for (const id of IDS) for (const action of [`subagent_record implementer ${id}`, `subagent_record reviewer ${id} unit`, `unit_finish ${id}`]) expect(log).toContain(action);
		expect(h.fake.spawned).toEqual([]);
		expect((await dataOf(h, "dispatch")).map((d) => [d.unit, d.agentSource, d.status])).toEqual(IDS.map((id) => [id, "inline", "DONE"]));
		expect((await dataOf(h, "finding-summary")).map((d) => [d.unit, d.agentSource, d.completed])).toEqual(IDS.map((id) => [id, "inline", true]));
		expect((await dataOf(h, "receipt")).map((r) => r.unit)).toEqual(IDS);
	});

	test("a lane that edits a file outside Files re-runs sequentially", async () => {
		const units = [unit("U1", "medium"), unit("U2", "medium")];
		const h = await subagentHarness({ units, scripts: SCRIPTS, executor: {} });
		const strayOnce: Work = async (role, unitId, cwd, prompt) => {
			if (role === "implementer" && unitId === "U1" && cwd !== h.root) await writeIn(cwd, "src/stray.ts", "export const stray = 1;\n");
			return honest(role, unitId, cwd, prompt);
		};
		playChildren(h, strayOnce);
		const log = await drive(h, { allow: ["lane_merge U1"] });
		expect(await ticked(h)).toEqual(["U1", "U2"]);
		expect(log).toContain("lane_merge U1 refused");
		const u1 = h.fake.spawned.filter((s) => s.type === "implementer" && s.options.metadata.unit === "U1");
		expect(u1.map((s) => s.options.cwd)).toEqual([join(h.root, ".worktrees", "per-ip-cap--U1"), h.root]);
		const closes = (await dataOf(h, "lane")).filter((d) => d.closed === true).map((d) => [d.unit, d.outcome]);
		expect(closes).toEqual(expect.arrayContaining([["U1", "violation"], ["U2", "merged"]]));
		const violation = (await dataOf(h, "finding-summary")).find((d) => d.system === "files-violation") as { findings: { location: string }[] };
		expect(violation.findings.map((f) => f.location)).toEqual(["src/stray.ts:1"]);
		expect(h.git("ls-files", "src")).not.toContain("stray.ts");
	});

	test("a missing required source is returned once, then BLOCKED; NEEDS_CONTEXT is no failure and is capped", async () => {
		const units = [unit("U1", "medium"), unit("U2", "medium")];
		const h = await subagentHarness({ units, scripts: SCRIPTS, executor: {} });
		const runs: Record<string, number> = {};
		playChildren(h, async (_role, unitId, _cwd, prompt) => {
			runs[unitId] = (runs[unitId] ?? 0) + 1;
			if (unitId === "U1") return done({ sources_used: [] });
			return done({ status: "NEEDS_CONTEXT", reason: "need spec:auth", evidence: "no auth spec in the packet", sources_used: footerIds(prompt) });
		});
		ok(await h.start("U1"), "unit_start U1");
		const blocked = textOf(await h.call("subagent_dispatch", { role: "implementer", unit: "U1" }));
		expect(runs.U1).toBe(2);
		expect(h.fake.resumed).toEqual([{ id: "agent-1", prompt: expect.stringContaining("omits required sources") }]);
		expect(blocked).toContain("BLOCKED");
		expect((await dataOf(h, "dispatch")).at(-1)).toMatchObject({ unit: "U1", status: "BLOCKED", attempt: 1 });

		const texts: string[] = [];
		for (let i = 0; i < 3; i++) texts.push(textOf(await h.call("subagent_dispatch", { role: "implementer", unit: "U2" })));
		expect(texts.slice(0, 2).every((t) => t.includes("Sources named: <untrusted>spec:auth") && !t.includes("spec_stuck"))).toBe(true);
		expect(texts[2]).toContain("spec_stuck");
		const u2 = h.fake.spawned.filter((s) => s.options.metadata.unit === "U2");
		expect(u2.map((s) => s.options.thinkingLevel)).toEqual(["medium", "medium", "medium"]);
		expect(cardState(h).state.evidence.attempts.U2 ?? 0).toBe(0);
		expect((await dataOf(h, "dispatch")).filter((d) => d.unit === "U2").map((d) => [d.status, d.attempt])).toEqual([
			["NEEDS_CONTEXT", 1],
			["NEEDS_CONTEXT", 1],
			["NEEDS_CONTEXT", 1],
		]);
	});
});
