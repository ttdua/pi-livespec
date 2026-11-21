import { afterEach, describe, expect, test } from "vitest";
import { type GitExec, defaultGitExec } from "../../src/engine/git-exec.ts";
import { createGit } from "../../src/engine/git.ts";
import { Session } from "../../src/hooks/session.ts";
import { shipContext } from "../../src/ship/context.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { stateFor } from "../helpers/change-state.ts";
import { fixture, sh } from "./repo.ts";

afterEach(() => undefined);

describe("shipContext", () => {
	test("two calls at the same HEAD fetch once", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "specs/glossary.md", "g\n");
		commitAll(f.work, "doc");
		const calls: string[][] = [];
		const exec: GitExec = (args, opts) => {
			calls.push(args);
			return defaultGitExec(args, opts);
		};
		const session = new Session(f.work, createGit(f.work, exec), exec);
		session.config = { ...session.config, project: { githubHosts: [], agentSkillsChannelSet: false, integrationBranch: "main" } };
		const head = sh(f.work, "rev-parse", "HEAD");
		const state = stateFor("ship", { git: { branch: "feature", head, dirty: false, specsChanged: true } }, `Base: ${base}\nBranch: feature\nCapabilities: new [], modified []\n\n## Durable docs\n`);
		const a = await shipContext(session, state);
		const b = await shipContext(session, state);
		expect(calls.filter((c) => c[0] === "fetch")).toHaveLength(1);
		expect(a).toMatchObject({ diff: { files: ["specs/glossary.md"] }, integrationTip: base, facts: { files: ["specs/glossary.md"] } });
		expect(b).toEqual(a);
	});

	test("a new HEAD fetches again", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		const calls: string[][] = [];
		const exec: GitExec = (args, opts) => {
			calls.push(args);
			return defaultGitExec(args, opts);
		};
		const session = new Session(f.work, createGit(f.work, exec), exec);
		session.config = { ...session.config, project: { githubHosts: [], agentSkillsChannelSet: false, integrationBranch: "main" } };
		const at = (head: string) => stateFor("ship", { git: { branch: "feature", head, dirty: false, specsChanged: true } }, `Base: ${base}\nBranch: feature\n\n## Durable docs\n`);
		await shipContext(session, at(base));
		await writeIn(f.work, "a.ts", "a\n");
		commitAll(f.work, "a");
		await shipContext(session, at(sh(f.work, "rev-parse", "HEAD")));
		expect(calls.filter((c) => c[0] === "fetch")).toHaveLength(2);
	});

	test("without a project config the context is refused", async () => {
		const f = await fixture();
		const session = new Session(f.work, f.git);
		const out = await shipContext(session, stateFor("ship"));
		expect(out).toHaveProperty("refused");
	});
});
