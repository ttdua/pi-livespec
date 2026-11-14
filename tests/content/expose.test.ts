import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { EXCLUDED_SKILLS, exposedSkillPaths } from "../../src/content/expose.ts";
import { ContentManager } from "../../src/content/manager.ts";
import { createMirror } from "../../src/content/mirror.ts";
import { contentPaths } from "../../src/content/paths.ts";
import { registerWorkInProgress, resetWorkInProgressForTests, workInProgress } from "../../src/content/wip.ts";
import { defaultGitExec } from "../../src/engine/git-exec.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { LoadedPack, Pack } from "../../src/engine/pack-types.ts";
import { LABEL_LIVESPEC, phaseLabel } from "../../src/forge/labels.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";
import { defaultPack, makeUpstream, skillFile, skillNamesOf, tempDir } from "./helpers.ts";

let pack: Pack;
let dir: string;

beforeAll(async () => {
	pack = await defaultPack();
});
beforeEach(async () => {
	dir = await tempDir("expose");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const valid = (p: Pack): LoadedPack => ({ ok: true, pack: p, warnings: [] });
const TREE = "/home/u/.pi/agent/livespec/agent-skills/" + "a".repeat(40);

describe("exposedSkillPaths", () => {
	test("Initialized project", () => {
		const paths = exposedSkillPaths({ initialized: true, pack: valid(pack), activeTree: TREE });
		expect(paths).toEqual(skillNamesOf(pack).map((n) => join(TREE, "skills", n)));
		for (const p of paths) expect(p).toMatch(/skills\/[a-z0-9-]+$/);
	});

	test("Uninitialized project", () => {
		expect(exposedSkillPaths({ initialized: false, pack: valid(pack), activeTree: TREE })).toEqual([]);
	});

	test("no clone exposes nothing", () => {
		expect(exposedSkillPaths({ initialized: true, pack: valid(pack) })).toEqual([]);
	});

	test("Excluded skills", async () => {
		await mkdir(join(dir, ".pi", "livespec"), { recursive: true });
		await writeFile(
			join(dir, ".pi", "livespec", "flow.yaml"),
			"extends: agent-skills\nphases:\n  - id: review\n    skills:\n      optional: [using-agent-skills, context-engineering]\n",
		);
		const loaded = await loadPack(dir);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		const excludedWarnings = loaded.warnings.filter((w) => EXCLUDED_SKILLS.some((s) => w.message.includes(s)));
		expect(excludedWarnings).toHaveLength(2);
		const paths = exposedSkillPaths({ initialized: true, pack: loaded, activeTree: TREE });
		for (const name of EXCLUDED_SKILLS) expect(paths.some((p) => p.endsWith(`skills/${name}`))).toBe(false);
		expect(paths.length).toBeGreaterThan(0);
	});

	test("No skills exposed", () => {
		const invalid: LoadedPack = { ok: false, errors: [{ severity: "error", file: "f", line: 1, col: 1, path: "", message: "bad" }] };
		expect(exposedSkillPaths({ initialized: true, pack: invalid, activeTree: TREE })).toEqual([]);
	});

	test("exposed paths resolve to the sha tree, not current", async () => {
		const upstream = await makeUpstream(dir, pack);
		const paths = contentPaths(join(dir, "home"));
		const m = new ContentManager({ paths, mirror: createMirror(paths, defaultGitExec), now: () => new Date(), source: upstream.url });
		const first = await m.clone(pack);
		if (first.kind !== "installed") throw new Error("clone failed");
		const active = await m.activeTree();
		const exposed = exposedSkillPaths({ initialized: true, pack: valid(pack), activeTree: active });
		const firstTree = await realpath(paths.tree(first.sha));
		for (const p of exposed) {
			expect(p.startsWith(`${firstTree}/`)).toBe(true);
			expect(p).not.toContain("/current/");
		}
		await upstream.commit({ "skills/interview-me/SKILL.md": skillFile("interview-me", "Changed.") });
		expect((await m.update(pack, { busy: false })).kind).toBe("installed");
		const sample = exposed.find((p) => p.endsWith("skills/interview-me"));
		expect(sample && (await realpath(sample))).toBe(join(firstTree, "skills", "interview-me"));
	});
});

describe("work in progress", () => {
	const BUILD = [LABEL_LIVESPEC, phaseLabel("build")];
	const units = (status: string) => `## Units\n### U1 — a\n- [x] done\n\n### U2 — b\n${status}\n`;

	afterEach(() => resetWorkInProgressForTests());

	test("default predicate is busy for a build change with a pending unit", async () => {
		const world = new MemoryWorld();
		await world.seedIssue({ title: "other", labels: [LABEL_LIVESPEC, phaseLabel("plan")], body: units("- [ ] pending") });
		const n = await world.seedIssue({ title: "rate-limit", labels: BUILD, body: units("- [ ] pending") });
		const wip = await workInProgress(world.forge);
		expect(wip.busy).toBe(true);
		expect(wip.change).toBe(n);
		expect(wip.reason).toContain("U2");
	});

	test("default predicate is idle when every build unit is done or the change is closed", async () => {
		const world = new MemoryWorld();
		await world.seedIssue({ labels: BUILD, body: units("- [x] done") });
		await world.seedIssue({ labels: BUILD, body: units("- [ ] pending"), state: "closed" });
		await world.seedIssue({ labels: [phaseLabel("build")], body: units("- [ ] pending") });
		expect(await workInProgress(world.forge)).toEqual({ busy: false });
	});

	test("the last registered predicate wins", async () => {
		const world = new MemoryWorld();
		registerWorkInProgress(async () => ({ busy: true, change: 1, reason: "first" }));
		registerWorkInProgress(async () => ({ busy: true, change: 7, reason: "started" }));
		expect(await workInProgress(world.forge)).toEqual({ busy: true, change: 7, reason: "started" });
	});
});
