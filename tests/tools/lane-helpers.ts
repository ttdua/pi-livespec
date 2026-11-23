// Opens a lane for a unit in tool tests: a clone of the change repo plus the `lane` record that names it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { setTestIdentity } from "../helpers/repo.ts";
import type { UnitHarness } from "./unit-helpers.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const gitIn = (cwd: string, ...args: string[]): string =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

/** A clone of the change repo at its HEAD, standing in for a lane worktree; `git` runs in it. */
export type Lane = { path: string; git: (...args: string[]) => string };

/** Clones the repo into a temp directory and posts the open `lane` record of `unit`. */
export async function openLane(h: UnitHarness, unit: string): Promise<Lane> {
	const path = join(mkdtempSync(join(tmpdir(), "ls-lane-")), "lane");
	dirs.push(join(path, ".."));
	execFileSync("git", ["clone", "-q", h.root, path]);
	setTestIdentity(path);
	await h.seed("lane", `lane.${unit}`, { unit, path, branch: `livespec/per-ip-cap--lane-${unit}`, base: h.head });
	return { path, git: (...args) => gitIn(path, ...args) };
}

/** A real git worktree of the change repo on the unit's lane branch at the current HEAD, plus its open `lane` record; it shares `origin`. */
export async function openWorktreeLane(h: UnitHarness, unit: string): Promise<Lane> {
	const path = join(mkdtempSync(join(tmpdir(), "ls-lane-")), "lane");
	dirs.push(join(path, ".."));
	const branch = `livespec/per-ip-cap--lane-${unit}`;
	const base = h.git("rev-parse", "HEAD");
	h.git("worktree", "add", "-q", "-b", branch, path, base);
	await h.seed("lane", `lane.${unit}`, { unit, path, branch, base });
	return { path, git: (...args) => gitIn(path, ...args) };
}
