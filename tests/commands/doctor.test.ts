import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	type DoctorDeps,
	type DoctorResult,
	formatDoctor,
	registerDoctorCheck,
	resetDoctorChecksForTests,
	runDoctor,
} from "../../src/commands/doctor.ts";
import { writeLock } from "../../src/content/lock.ts";
import { ContentManager } from "../../src/content/manager.ts";
import type { Mirror } from "../../src/content/mirror.ts";
import { type ContentPaths, contentPaths } from "../../src/content/paths.ts";
import type { LoadedPack, Pack } from "../../src/engine/pack-types.ts";
import { ForgeError } from "../../src/forge/errors.ts";
import type { Forge } from "../../src/forge/types.ts";
import { defaultPack, tempDir, validTreeFiles, writeTree } from "../content/helpers.ts";

const SHA = "a".repeat(40);
const PIN = "b".repeat(40);
const CHECKED_AT = "2026-11-14T08:00:00.000Z";
const STAGING = `.staging-${"c".repeat(40)}-0badf00d`;
const SNIPPET = '{"packages":[{"source":"<superpowers source>","skills":[],"extensions":[]}]}';

let pack: Pack;
let dir: string;
let root: string;
let home: string;
let paths: ContentPaths;

beforeAll(async () => {
	pack = await defaultPack();
});
beforeEach(async () => {
	dir = await tempDir("doctor");
	root = join(dir, "project");
	home = join(dir, "home");
	paths = contentPaths(home);
	await mkdir(root, { recursive: true });
	resetDoctorChecksForTests();
});
afterEach(async () => {
	resetDoctorChecksForTests();
	await rm(dir, { recursive: true, force: true });
});

const refuse = (what: string) => () => {
	throw new Error(`doctor must not call ${what}`);
};

/** Every mirror call would write; doctor must never reach it. */
const refusingMirror: Mirror = { ensure: refuse("mirror.ensure"), fetch: refuse("mirror.fetch"), checkout: refuse("mirror.checkout"), resolve: refuse("mirror.resolve") };

function fakeForge(whoami: () => Promise<{ login: string }>): Forge {
	return new Proxy({ kind: "github", whoami } as Partial<Forge>, {
		get: (target, key) => (key in target ? target[key as keyof Forge] : refuse(`forge.${String(key)}`)),
	}) as Forge;
}
const healthyForge = async () => ({ forge: fakeForge(async () => ({ login: "alice" })), readOnly: false });

async function installClone(o: { pinned?: string | null; skip?: string[]; staging?: boolean } = {}): Promise<void> {
	const files = validTreeFiles(pack);
	for (const name of o.skip ?? []) delete files[`skills/${name}/SKILL.md`];
	await writeTree(paths.tree(SHA), files);
	await symlink(paths.tree(SHA), paths.current);
	await writeLock(paths.lock, { source: "file:///upstream.git", commit: SHA, pinned: o.pinned ?? null, history: [SHA], skipped: [], checkedAt: CHECKED_AT });
	if (o.staging) await mkdir(join(paths.root, STAGING, "skills"), { recursive: true });
}

async function exists(p: string): Promise<boolean> {
	try {
		await lstat(p);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
async function listDir(p: string): Promise<string[]> {
	try {
		return (await readdir(p)).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
	const loaded: LoadedPack = { ok: true, pack, warnings: [] };
	return {
		root,
		home,
		initialized: true,
		pack: loaded,
		loadedSkills: [],
		isTrusted: true,
		content: new ContentManager({ paths, mirror: refusingMirror, now: refuse("now") as () => Date, source: "file:///upstream.git" }),
		forge: healthyForge,
		exists,
		listDir,
		config: { project: null, user: { agentSkills: { channel: "auto" } }, warnings: [] },
		hasUI: true,
		...over,
	};
}

const byId = (results: DoctorResult[], id: string) => results.filter((r) => r.id === id);
const nonOk = (results: DoctorResult[]) => results.filter((r) => r.status !== "ok");

/** Every file under `dir` with its type, content or link target. */
async function treeSnapshot(base: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const walk = async (p: string, rel: string): Promise<void> => {
		const s = await lstat(p);
		if (s.isSymbolicLink()) out[rel] = `link:${await readlink(p)}`;
		else if (s.isDirectory()) {
			out[rel] = `dir:${s.mtimeMs}`;
			for (const name of await readdir(p)) await walk(join(p, name), join(rel, name));
		} else out[rel] = `file:${s.mtimeMs}:${await readFile(p, "utf8")}`;
	};
	await walk(base, ".");
	return out;
}

describe("runDoctor", () => {
	test("healthy setup reports only ok", async () => {
		await installClone();
		const results = await runDoctor(deps());
		expect(nonOk(results)).toEqual([]);
		expect(results.length).toBeGreaterThan(0);
	});

	test("Report only", async () => {
		await installClone({ skip: ["idea-refine"], staging: true, pinned: PIN });
		await writeTree(root, { "openspec/project.md": "# p\n", ".pi/livespec/config.yaml": "integrationBrnach: main\nagentSkills: { channel: notify }\n" });
		registerDoctorCheck("always-fails", async () => [{ id: "always-fails", status: "error", message: "broken" }]);
		const before = await treeSnapshot(dir);
		const results = await runDoctor(
			deps({
				initialized: false,
				isTrusted: false,
				loadedSkills: [
					{ name: "spec-driven-development", filePath: join(home, ".agents", "skills", "spec-driven-development", "SKILL.md") },
					{ name: "using-superpowers", filePath: join(home, "sp", "using-superpowers", "SKILL.md") },
				],
				forge: async () => {
					throw new Error("no origin remote");
				},
			}),
		);
		expect(nonOk(results).length).toBeGreaterThanOrEqual(8);
		expect(await treeSnapshot(dir)).toEqual(before);
	});

	test("Registered check", async () => {
		await installClone();
		registerDoctorCheck("approver", async () => [{ id: "approver", status: "warn", message: "no approver", suggestion: "set one" }]);
		const results = await runDoctor(deps());
		expect(byId(results, "approver")).toEqual([{ id: "approver", status: "warn", message: "no approver", suggestion: "set one" }]);
		expect(formatDoctor(results)).toContain("warn approver: no approver\n  → set one");
	});

	test("a throwing registered check becomes an error result", async () => {
		await installClone();
		registerDoctorCheck("flaky", async () => {
			throw new Error("boom");
		});
		expect(byId(await runDoctor(deps()), "flaky")).toEqual([{ id: "flaky", status: "error", message: "check failed: boom" }]);
	});

	test("Duplicate skill", async () => {
		await installClone();
		const shadow = join(home, ".agents", "skills", "spec-driven-development", "SKILL.md");
		const inClone = join(await realpath(paths.tree(SHA)), "skills", "interview-me", "SKILL.md");
		const results = await runDoctor(
			deps({ loadedSkills: [{ name: "spec-driven-development", filePath: shadow }, { name: "interview-me", filePath: inClone }] }),
		);
		const dup = nonOk(byId(results, "duplicate-skills"));
		expect(dup).toHaveLength(1);
		expect(dup[0]?.status).toBe("warn");
		expect(dup[0]?.message).toContain("spec-driven-development");
		expect(dup[0]?.message).toContain(shadow);
		expect(dup[0]?.message).toContain("pi keeps the first skill found");
	});

	test("Missing pack skill", async () => {
		await installClone({ skip: ["idea-refine"] });
		const missing = nonOk(byId(await runDoctor(deps()), "pack-skills"));
		expect(missing).toHaveLength(1);
		expect(missing[0]?.status).toBe("error");
		expect(missing[0]?.message).toContain("idea-refine");
	});

	test("Superpowers in an untrusted project", async () => {
		await installClone();
		const results = await runDoctor(
			deps({ isTrusted: false, loadedSkills: [{ name: "using-superpowers", filePath: join(home, "sp", "SKILL.md") }] }),
		);
		const sp = byId(results, "superpowers");
		expect(sp).toHaveLength(1);
		expect(sp[0]?.status).toBe("warn");
		expect(sp[0]?.suggestion).toContain(SNIPPET);
		expect(sp[0]?.suggestion).toContain(".pi/settings.json");
		expect(sp[0]?.suggestion).toContain("trusted project");
		expect(sp[0]?.suggestion).toContain("/trust");
	});

	test("Superpowers in a trusted project", async () => {
		await installClone();
		const results = await runDoctor(
			deps({ isTrusted: true, loadedSkills: [{ name: "using-superpowers", filePath: join(home, "sp", "SKILL.md") }] }),
		);
		const sp = byId(results, "superpowers");
		expect(sp[0]?.status).toBe("warn");
		expect(sp[0]?.suggestion).toContain(SNIPPET);
		expect(sp[0]?.suggestion).not.toContain("trust");
	});

	test("Forge read-only", async () => {
		await installClone();
		const unreachable = new ForgeError({ code: "unreachable", operation: "whoami", message: "connect ECONNREFUSED" });
		const results = await runDoctor(
			deps({ forge: async () => ({ forge: fakeForge(async () => Promise.reject(unreachable)), readOnly: false }) }),
		);
		const forge = nonOk(byId(results, "forge"));
		expect(forge.some((r) => r.message.includes("read-only"))).toBe(true);
	});

	test("forge already in read-only mode is reported", async () => {
		await installClone();
		const results = await runDoctor(deps({ forge: async () => ({ forge: fakeForge(async () => ({ login: "alice" })), readOnly: true }) }));
		expect(nonOk(byId(results, "forge")).some((r) => r.message.includes("read-only"))).toBe(true);
	});

	test("OpenSpec folder", async () => {
		await installClone();
		await mkdir(join(root, "openspec"));
		const results = await runDoctor(deps({ initialized: false }));
		const os = nonOk(byId(results, "openspec"));
		expect(os).toHaveLength(1);
		expect(os[0]?.suggestion).toContain("/livespec migrate-openspec");
	});

	test("Clone state", async () => {
		await installClone({ pinned: PIN, staging: true });
		const clone = byId(await runDoctor(deps()), "clone");
		const text = formatDoctor(clone);
		expect(text).toContain(SHA);
		expect(text).toContain(`pinned ${PIN}`);
		expect(text).toContain(CHECKED_AT);
		const staging = clone.filter((r) => r.status === "warn");
		expect(staging).toHaveLength(1);
		expect(staging[0]?.message).toContain(join(paths.root, STAGING));
	});

	test("No clone", async () => {
		const clone = nonOk(byId(await runDoctor(deps()), "clone"));
		expect(clone).toHaveLength(1);
		expect(clone[0]?.status).toBe("error");
		expect(clone[0]?.suggestion).toContain("/livespec init");
	});

	test("Forge detection fails", async () => {
		await installClone();
		const results = await runDoctor(
			deps({
				forge: async () => {
					throw new Error("cannot detect the forge: no origin remote");
				},
			}),
		);
		const forge = byId(results, "forge");
		expect(forge).toHaveLength(1);
		expect(forge[0]?.status).toBe("error");
		expect(forge[0]?.message).toContain("cannot detect the forge: no origin remote");
	});

	test("Forge auth fails", async () => {
		await installClone();
		const auth = new ForgeError({ code: "auth", operation: "whoami", message: "bad credentials", status: 401 });
		const results = await runDoctor(deps({ forge: async () => ({ forge: fakeForge(async () => Promise.reject(auth)), readOnly: false }) }));
		const forge = nonOk(byId(results, "forge"));
		expect(forge).toHaveLength(1);
		expect(forge[0]?.status).toBe("error");
		expect(forge[0]?.message).toContain("authentication");
		expect(forge[0]?.message).toContain("bad credentials");
	});

	test("Channel in project config", async () => {
		await installClone();
		await writeTree(root, { ".pi/livespec/config.yaml": "agentSkills:\n  channel: notify\n" });
		const config = nonOk(byId(await runDoctor(deps()), "config"));
		expect(config).toHaveLength(1);
		expect(config[0]?.status).toBe("warn");
		expect(config[0]?.message).toContain("agentSkills.channel");
		expect(config[0]?.message).toContain("user config");
	});

	test("unknown config key is reported", async () => {
		await installClone();
		await writeTree(root, { ".pi/livespec/config.yaml": "integrationBrnach: main\n" });
		const config = nonOk(byId(await runDoctor(deps()), "config"));
		expect(config.map((r) => r.message).join("\n")).toContain("integrationBrnach");
	});

	test("invalid pack is an error", async () => {
		await installClone();
		const invalid: LoadedPack = { ok: false, errors: [{ severity: "error", file: "pack.yaml", line: 2, col: 3, path: "phases", message: "bad" }] };
		const packResults = nonOk(byId(await runDoctor(deps({ pack: invalid })), "pack"));
		expect(packResults).toEqual([{ id: "pack", status: "error", message: "pack.yaml:2:3 phases: bad" }]);
	});
});

describe("formatDoctor", () => {
	test("one line per result with an optional suggestion line", () => {
		expect(
			formatDoctor([
				{ id: "a", status: "ok", message: "fine" },
				{ id: "b", status: "error", message: "bad", suggestion: "fix it" },
			]),
		).toBe("ok a: fine\nerror b: bad\n  → fix it");
	});
});
