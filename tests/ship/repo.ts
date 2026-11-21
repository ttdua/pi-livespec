import { execFileSync } from "node:child_process";
import { createGit, type Git } from "../../src/engine/git.ts";
import { commitAll, makeRepo, setTestIdentity, writeIn } from "../helpers/repo.ts";

export function sh(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export type Fixture = { work: string; upstream: string; git: Git };

/** A clone `work` of a bare `origin` whose `main` has one commit; HEAD is a branch `feature` forked from it. */
export async function fixture(): Promise<Fixture> {
	const seed = await makeRepo();
	sh(seed, "checkout", "-q", "-b", "main");
	await writeIn(seed, "README.md", "x\n");
	commitAll(seed);
	const parent = await makeRepo();
	sh(parent, "clone", "-q", "--bare", seed, "origin.git");
	sh(parent, "clone", "-q", `${parent}/origin.git`, "work");
	sh(parent, "clone", "-q", `${parent}/origin.git`, "other");
	setTestIdentity(`${parent}/work`);
	setTestIdentity(`${parent}/other`);
	sh(`${parent}/work`, "checkout", "-q", "-b", "feature");
	return { work: `${parent}/work`, upstream: `${parent}/other`, git: createGit(`${parent}/work`) };
}

/** Commits a file in the `other` clone onto main and pushes it to origin. */
export async function upstreamCommit(f: Fixture, rel: string, text = "u\n"): Promise<void> {
	await writeIn(f.upstream, rel, text);
	commitAll(f.upstream, `upstream ${rel}`);
	sh(f.upstream, "push", "-q", "origin", "HEAD:main");
}
