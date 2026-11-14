import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { runInit } from "../../src/commands/init.ts";
import { runValidate } from "../../src/commands/validate.ts";
import { loadConfig } from "../../src/config.ts";
import { ContentManager } from "../../src/content/manager.ts";
import { createMirror } from "../../src/content/mirror.ts";
import { contentPaths } from "../../src/content/paths.ts";
import { TEMPLATE_MARKER } from "../../src/core/templates.ts";
import { defaultGitExec } from "../../src/engine/git-exec.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { LoadedPack, Pack } from "../../src/engine/pack-types.ts";
import { type Upstream, defaultPack, makeUpstream, tempDir } from "../content/helpers.ts";

const FILES = ["specs/product.md", "specs/glossary.md", "specs/constraints.md", "specs/decisions/", ".pi/livespec/config.yaml"];
const CLONE = "agent-skills";

let pack: Pack;
let dir: string;
let root: string;
let home: string;
let upstream: Upstream;

beforeAll(async () => {
	pack = await defaultPack();
});
beforeEach(async () => {
	dir = await tempDir("init");
	root = join(dir, "project");
	home = join(dir, "home");
	upstream = await makeUpstream(dir, pack);
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function manager(source = upstream.url): ContentManager {
	const paths = contentPaths(home);
	return new ContentManager({ paths, mirror: createMirror(paths, defaultGitExec), now: () => new Date("2026-11-14T08:00:00Z"), source });
}
const deps = (content = manager()) => ({ content, pack: () => loadPack(root) });

async function snapshot(): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const rel of ["specs/product.md", "specs/glossary.md", "specs/constraints.md", ".pi/livespec/config.yaml"]) {
		out[rel] = await readFile(join(root, rel), "utf8");
	}
	out["specs/decisions"] = (await readdir(join(root, "specs", "decisions"))).join(",");
	return out;
}

describe("runInit", () => {
	test("Fresh project", async () => {
		const report = await runInit(root, deps());
		expect(report.created).toEqual([...FILES, CLONE]);
		expect(report.kept).toEqual([]);
		expect(report.failed).toEqual([]);
		for (const rel of FILES) await stat(join(root, rel));
		expect((await stat(join(root, "specs", "decisions"))).isDirectory()).toBe(true);
		expect(await manager().activeTree()).toBeDefined();
		expect((await readFile(join(root, "specs", "constraints.md"), "utf8")).split("\n")[0]).toBe(TEMPLATE_MARKER);
		expect(await readFile(join(root, "specs", "glossary.md"), "utf8")).toBe("# Glossary\n");
		const config = await loadConfig(root, home);
		expect(config.project).not.toBeNull();
		expect(config.warnings).toEqual([]);
	});

	test("Idempotent", async () => {
		await runInit(root, deps());
		await writeFile(join(root, "specs", "product.md"), "# My product\n\nEdited by the user.\n");
		const before = await snapshot();
		const report = await runInit(root, deps());
		expect(await snapshot()).toEqual(before);
		expect(report.created).toEqual([]);
		expect(report.kept).toEqual([...FILES, CLONE]);
		expect(report.failed).toEqual([]);
	});

	test("Clone failure", async () => {
		const missing = join(dir, "missing.git");
		const report = await runInit(root, deps(manager(missing)));
		expect(report.created).toEqual(FILES);
		expect(report.failed).toHaveLength(1);
		expect(report.failed[0]?.path).toBe(CLONE);
		expect(report.failed[0]?.reason).toContain(missing);
		for (const rel of FILES) await stat(join(root, rel));
	});

	test("rerun completes the clone", async () => {
		await runInit(root, deps(manager(join(dir, "missing.git"))));
		const report = await runInit(root, deps());
		expect(report.created).toEqual([CLONE]);
		expect(report.kept).toEqual(FILES);
		expect(report.failed).toEqual([]);
		expect(await manager().activeTree()).toBeDefined();
	});

	test("Templates validate", async () => {
		await runInit(root, deps());
		expect(await runValidate(root)).toEqual([]);
	});

	test("invalid pack still writes the files and fails the clone with the pack errors", async () => {
		const invalid: LoadedPack = { ok: false, errors: [{ severity: "error", file: "pack.yaml", line: 3, col: 1, path: "phases", message: "bad phases" }] };
		let cloned = false;
		const content = { clone: async () => ((cloned = true), { kind: "exists" as const, sha: "x" }), activeTree: async () => undefined };
		const report = await runInit(root, { content, pack: async () => invalid });
		expect(report.created).toEqual(FILES);
		expect(report.failed).toEqual([{ path: CLONE, reason: "the flow pack is invalid: pack.yaml:3:1 phases: bad phases" }]);
		expect(cloned).toBe(false);
	});
});
