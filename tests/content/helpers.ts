// A local agent-skills upstream: a bare repository fed from a work repository,
// holding a valid `skills/<name>/SKILL.md` for every skill of the default pack
// plus `agents/code-reviewer.md`.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultGitExec } from "../../src/engine/git-exec.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";

const GIT_CONFIG = ["-c", "user.name=livespec-test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

export const PERSONA = "code-reviewer";

export async function tempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `ls-content-${prefix}-`));
}

/** The default pack, loaded against an empty project root. */
export async function defaultPack(): Promise<Pack> {
	const root = await tempDir("root");
	try {
		const loaded = await loadPack(root);
		if (!loaded.ok) throw new Error(`default pack is invalid: ${JSON.stringify(loaded.errors)}`);
		return loaded.pack;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** Every skill named by the pack, written independently of the production helper. */
export function skillNamesOf(pack: Pack): string[] {
	const names = new Set(pack.init.skills);
	for (const phase of pack.phases) for (const s of [...phase.skills.required, ...phase.skills.optional]) names.add(s);
	return [...names].sort();
}

export function skillFile(name: string, description = `Use for ${name}.`, body = "Body.\n"): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

/** Writes `files` (relative path → content, `null` deletes the path) under `dir`. */
export async function writeTree(dir: string, files: Record<string, string | null>): Promise<void> {
	for (const [rel, content] of Object.entries(files)) {
		const path = join(dir, rel);
		if (content === null) {
			await rm(path, { recursive: true, force: true });
			continue;
		}
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
	}
}

export function validTreeFiles(pack: Pack): Record<string, string> {
	const files: Record<string, string> = { [`agents/${PERSONA}.md`]: "# Code reviewer\n" };
	for (const name of ["security-auditor", "web-performance-auditor", "test-engineer"]) files[`agents/${name}.md`] = `# ${name}\n`;
	for (const name of skillNamesOf(pack)) files[`skills/${name}/SKILL.md`] = skillFile(name);
	return files;
}

async function git(args: string[], cwd?: string): Promise<string> {
	const r = await defaultGitExec([...GIT_CONFIG, ...args], { cwd });
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout.trim();
}

export type Upstream = {
	/** The bare repository path, used as the clone source. */
	url: string;
	/** Applies `files` to the work tree, commits and pushes; returns the new sha. */
	commit(files: Record<string, string | null>, message?: string): Promise<string>;
};

export async function makeUpstream(dir: string, pack: Pack): Promise<Upstream> {
	const url = join(dir, "upstream.git");
	const work = join(dir, "upstream-work");
	await git(["init", "--quiet", "--bare", "-b", "main", url]);
	await git(["init", "--quiet", "-b", "main", work]);
	let count = 0;
	const commit = async (files: Record<string, string | null>, message?: string): Promise<string> => {
		await writeTree(work, files);
		count += 1;
		await git(["add", "-A"], work);
		await git(["commit", "--quiet", "--allow-empty", "-m", message ?? `commit ${count}`], work);
		await git(["push", "--quiet", url, "HEAD:main"], work);
		return git(["rev-parse", "HEAD"], work);
	};
	await commit(validTreeFiles(pack), "initial");
	return { url, commit };
}
