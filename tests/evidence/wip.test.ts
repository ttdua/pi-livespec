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
import { newEvidenceId } from "../../src/evidence/records.ts";
import { writeMarked } from "../../src/forge/markers.ts";
import { registerStartedUnitWorkInProgress } from "../../src/evidence/wip.ts";
import { LABEL_LIVESPEC, phaseLabel } from "../../src/forge/labels.ts";
import { createLedger, type Ledger } from "../../src/ledger/index.ts";
import { makeRepo } from "../helpers/repo.ts";
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

/** The `unit-start` data of `unit` at its current digest. */
function startData(unit: string) {
	const u = parseChange(BODY).units.find((x) => x.id === unit);
	if (!u) throw new Error(`no unit ${unit}`);
	const data = {
		unit,
		digest: unitDigest(u),
		verify: u.verify ?? "",
		pre: { sha: "a".repeat(40), exit: 1, verdict: "red" as const, output: "" },
	};
	return data;
}

/** Posts a raw own `unit-start` comment for `unit`, as writers did before the ledger (older changes still carry them). */
async function startUnitComment(world: MemoryWorld, n: number, unit: string): Promise<void> {
	await world.postComment(n, BOT_LOGIN, writeMarked("unit-start", newEvidenceId(unit, new Date()), startData(unit)));
}

/** Appends a `unit-start` entry for `unit` to the ledger of change `n`. */
async function startUnit(n: number, unit: string): Promise<void> {
	await ledger.append(n, { kind: "unit-start", id: newEvidenceId(unit, new Date()), data: startData(unit) });
}

let pack: Pack;
let dir: string;
let upstream: Upstream;
let clock: Date;
let ledger: Ledger;

beforeAll(async () => {
	pack = await defaultPack();
});
beforeEach(async () => {
	dir = await tempDir("wip");
	upstream = await makeUpstream(dir, pack);
	clock = START;
	ledger = createLedger(defaultGitExec, await makeRepo());
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
	test("a unit-start ledger entry is work in progress", async () => {
		const { world, n } = await worldWithChangeSeven(BODY);
		await startUnit(n, "U2");
		registerStartedUnitWorkInProgress();
		expect(await workInProgress(world.forge, ledger)).toEqual({ busy: true, change: 7, reason: "change #7 has U2 started" });
	});

	test("a unit-start comment is still work in progress", async () => {
		const { world, n } = await worldWithChangeSeven(BODY);
		await startUnitComment(world, n, "U2");
		registerStartedUnitWorkInProgress();
		expect(await workInProgress(world.forge, ledger)).toMatchObject({ busy: true, change: 7 });
	});

	test("Started unit blocks upgrades", async () => {
		const { world, n } = await worldWithChangeSeven(BODY);
		await startUnit(n, "U2");
		registerStartedUnitWorkInProgress();
		const wip = await workInProgress(world.forge, ledger);
		expect(wip.busy).toBe(true);
		expect(wip.change).toBe(7);
		expect(wip.reason).toContain("#7");
		expect(wip.reason).toContain("U2");
	});

	test("Between units", async () => {
		const { world } = await worldWithChangeSeven(BODY);
		registerStartedUnitWorkInProgress();
		expect(await workInProgress(world.forge, ledger)).toEqual({ busy: false });
	});
});

describe("agent-skills-content", () => {
	test("Build in progress", async () => {
		const { world, n } = await worldWithChangeSeven(BODY);
		await startUnit(n, "U2");
		registerStartedUnitWorkInProgress();
		const m = manager();
		await m.clone(pack);
		await upstream.commit(CHANGED_INTERVIEW);
		advance(25);
		const r = await m.autoCheck(pack, "auto", await workInProgress(world.forge, ledger));
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
		const r = await m.autoCheck(pack, "auto", await workInProgress(world.forge, ledger));
		expect(r.kind).toBe("installed");
	});

	test("Manual update refused in build", async () => {
		const { world, n } = await worldWithChangeSeven(BODY);
		await startUnit(n, "U2");
		registerStartedUnitWorkInProgress();
		const m = manager();
		const first = await m.clone(pack);
		if (first.kind !== "installed") throw new Error("clone failed");
		await upstream.commit(CHANGED_INTERVIEW);
		const wip = await workInProgress(world.forge, ledger);
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
		await startUnit(n, "U2");
		registerStartedUnitWorkInProgress();
		expect(await workInProgress(world.forge, ledger)).toMatchObject({ busy: true });
		const r = await m.rollback();
		expect(r).toMatchObject({ kind: "installed", sha: first.sha });
	});
});
