import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { ContentManager } from "../../src/content/manager.ts";
import { createMirror } from "../../src/content/mirror.ts";
import { contentPaths } from "../../src/content/paths.ts";
import { type WorkInProgress, resetWorkInProgressForTests, workInProgress } from "../../src/content/wip.ts";
import { defaultGitExec } from "../../src/engine/git-exec.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { newEvidenceId, startComment } from "../../src/evidence/records.ts";
import { registerStartedUnitWorkInProgress } from "../../src/evidence/wip.ts";
import { LABEL_LIVESPEC, phaseLabel } from "../../src/forge/labels.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { type Upstream, defaultPack, makeUpstream, skillFile, tempDir } from "../content/helpers.ts";

const BUILD = [LABEL_LIVESPEC, phaseLabel("build")];
const HOUR_MS = 3_600_000;
const START = new Date("2026-11-14T08:00:00Z");
const IDLE: WorkInProgress = { busy: false };
const CHANGED_INTERVIEW = { "skills/interview-me/SKILL.md": skillFile("interview-me", "Use for interview-me.", "New body.\n") };

const unitBlock = (n: number, done: boolean): string =>
	`### U${n} — t${n}\nCovers: c/Requirement: R\nFiles: src/a${n}.ts\nDone means:\n- [a] x\nScenarios:\n- [a] t › x\nDepends: —\nVerify: \`bun test a${n}\`\n- [${done ? "x" : " "}] ${done ? "done" : "pending"}\n`;

/** U1 done, U2 pending: a `build` change between units when nothing is started. */
const BODY = `## Units\n${unitBlock(1, true)}\n${unitBlock(2, false)}`;

/** Posts an own `unit-start` comment for `unit` with the unit's current digest. */
async function startUnit(world: MemoryWorld, n: number, unit: string): Promise<void> {
	const u = parseChange(BODY).units.find((x) => x.id === unit);
	if (!u) throw new Error(`no unit ${unit}`);
	const data = {
		unit,
		digest: unitDigest(u),
		verify: u.verify ?? "",
		pre: { sha: "a".repeat(40), exit: 1, verdict: "red" as const, output: "" },
	};
	await world.postComment(n, BOT_LOGIN, startComment(newEvidenceId(unit, new Date()), data));
}

let pack: Pack;
let dir: string;
let upstream: Upstream;
let clock: Date;

beforeAll(async () => {
	pack = await defaultPack();
});
beforeEach(async () => {
	dir = await tempDir("wip");
	upstream = await makeUpstream(dir, pack);
	clock = START;
});
afterEach(async () => {
	resetWorkInProgressForTests();
	await rm(dir, { recursive: true, force: true });
});

function manager(): ContentManager {
	const paths = contentPaths(join(dir, "home"));
	return new ContentManager({ paths, mirror: createMirror(paths, defaultGitExec), now: () => clock, source: upstream.url });
}

const advance = (hours: number) => {
	clock = new Date(clock.getTime() + hours * HOUR_MS);
};

/** Seeds issues until the next one is `#7`, so the started change matches the spec's number. */
async function worldWithChangeSeven(body: string): Promise<{ world: MemoryWorld; n: number }> {
	const world = new MemoryWorld();
	for (let i = 0; i < 6; i++) await world.seedIssue({ title: "other", labels: [LABEL_LIVESPEC, phaseLabel("plan")] });
	const n = await world.seedIssue({ title: "rate-limit", labels: BUILD, body });
	return { world, n };
}

describe("unit-evidence", () => {
	test("Started unit blocks upgrades", async () => {
		const { world, n } = await worldWithChangeSeven(BODY);
		await startUnit(world, n, "U2");
		registerStartedUnitWorkInProgress();
		const wip = await workInProgress(world.forge);
		expect(wip.busy).toBe(true);
		expect(wip.change).toBe(7);
		expect(wip.reason).toContain("#7");
		expect(wip.reason).toContain("U2");
	});

	test("Between units", async () => {
		const { world } = await worldWithChangeSeven(BODY);
		registerStartedUnitWorkInProgress();
		expect(await workInProgress(world.forge)).toEqual({ busy: false });
	});
});

describe("agent-skills-content", () => {
	test("Build in progress", async () => {
		const { world, n } = await worldWithChangeSeven(BODY);
		await startUnit(world, n, "U2");
		registerStartedUnitWorkInProgress();
		const m = manager();
		await m.clone(pack);
		await upstream.commit(CHANGED_INTERVIEW);
		advance(25);
		const r = await m.autoCheck(pack, "auto", await workInProgress(world.forge));
		expect(r.kind).toBe("skipped");
		if (r.kind === "skipped") expect(r.reason).toContain("#7");
	});

	test("Pending units without a started unit", async () => {
		const { world } = await worldWithChangeSeven(BODY);
		registerStartedUnitWorkInProgress();
		const m = manager();
		await m.clone(pack);
		await upstream.commit(CHANGED_INTERVIEW);
		advance(25);
		const r = await m.autoCheck(pack, "auto", await workInProgress(world.forge));
		expect(r.kind).toBe("installed");
	});

	test("Manual update refused in build", async () => {
		const { world, n } = await worldWithChangeSeven(BODY);
		await startUnit(world, n, "U2");
		registerStartedUnitWorkInProgress();
		const m = manager();
		const first = await m.clone(pack);
		if (first.kind !== "installed") throw new Error("clone failed");
		await upstream.commit(CHANGED_INTERVIEW);
		const wip = await workInProgress(world.forge);
		const updated = await m.update(pack, wip);
		expect(updated.kind).toBe("refused");
		if (updated.kind === "refused") expect(updated.reason).toContain("#7");
		const pinned = await m.pin(first.sha, pack, wip);
		expect(pinned.kind).toBe("refused");
		if (pinned.kind === "refused") expect(pinned.reason).toContain("#7");
	});

	test("Rollback allowed in build", async () => {
		const { world, n } = await worldWithChangeSeven(BODY);
		const m = manager();
		const first = await m.clone(pack);
		if (first.kind !== "installed") throw new Error("clone failed");
		await upstream.commit(CHANGED_INTERVIEW);
		expect((await m.update(pack, IDLE)).kind).toBe("installed");
		await startUnit(world, n, "U2");
		registerStartedUnitWorkInProgress();
		expect(await workInProgress(world.forge)).toMatchObject({ busy: true });
		const r = await m.rollback();
		expect(r).toMatchObject({ kind: "installed", sha: first.sha });
	});
});
