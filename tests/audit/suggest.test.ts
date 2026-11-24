// drift-audit "Audit suggestions": the commit scan, the initiative suggestion and the state an audit leaves.

import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { createGit } from "../../src/engine/git.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";
import {
	addInitiative,
	auditAndSave,
	completeAudit,
	initiativeAndSave,
	pendingReasons,
	scanCommits,
	type ScanDeps,
	suggestAtStart,
} from "../../src/audit/suggest.ts";
import { type AuditState, readAuditState, writeAuditState } from "../../src/audit/state.ts";
import { ForgeError } from "../../src/forge/errors.ts";
import { forgeOf, pullRequest } from "./seeded.ts";

type FakeCommit = { sha: string; subject: string; paths: string[] };

const SPECS = [
	{ capability: "rate-limit", paths: ["src/limit/**"] },
	{ capability: "cache", paths: ["src/cache/**"] },
];

const sha = (c: string): string => c.repeat(40).slice(0, 40);
const AAA = sha("a");
const BBB = sha("b");

/** A first-parent history after `base`, with the paths each commit brings; `origin/main` is its last commit. */
function history(base: string, commits: FakeCommit[]): ScanDeps["git"] & { pathCalls: string[]; tip: string } {
	const pathCalls: string[] = [];
	const tip = commits.at(-1)?.sha ?? base;
	return {
		pathCalls,
		tip,
		firstParentCommits: async (commit, o) => {
			if (commit !== tip) throw new Error(`unexpected tip ${commit}`);
			const from = o.after === undefined || o.after === base ? 0 : commits.findIndex((c) => c.sha === o.after) + 1;
			return commits.slice(from).map(({ sha, subject }) => ({ sha, subject }));
		},
		commitPaths: async (commit) => {
			pathCalls.push(commit);
			return commits.find((c) => c.sha === commit)?.paths ?? [];
		},
	};
}

const deps = (git: ScanDeps["git"] & { tip: string }, forge: ScanDeps["forge"] = forgeOf([])): ScanDeps => ({
	git,
	...(forge === undefined ? {} : { forge }),
	tip: git.tip,
	specs: SPECS,
});

/** The state a scan leaves; a scan error fails the test unless it is checked through `scanCommits` directly. */
async function scanState(d: ScanDeps, s: AuditState): Promise<AuditState> {
	const r = await scanCommits(d, s);
	if (r.error !== undefined) throw r.error;
	return r.state;
}

describe("scanCommits", () => {
	test("first run sets the cursor only", async () => {
		const git = history(AAA, [{ sha: BBB, subject: "tweak limits", paths: ["src/limit/cap.ts"] }]);
		expect(await scanState(deps(git), { pending: [] })).toEqual({ cursor: BBB, pending: [] });
		expect(git.pathCalls).toEqual([]);
	});

	test("Manual commit suggests an audit", async () => {
		const git = history(AAA, [{ sha: BBB, subject: "tweak limits", paths: ["src/limit/cap.ts", "README.md"] }]);
		const next = await scanState(deps(git), { cursor: AAA, pending: [] });
		expect(next).toEqual({ cursor: BBB, pending: [{ kind: "commit", sha: BBB, capabilities: ["rate-limit"] }] });
		expect(pendingReasons(next)).toEqual([`commit ${BBB.slice(0, 7)} touches rate-limit`]);
	});

	test("a commit outside every capability's paths is not suggested", async () => {
		const git = history(AAA, [{ sha: BBB, subject: "docs", paths: ["README.md"] }]);
		expect(await scanState(deps(git), { cursor: AAA, pending: [] })).toEqual({ cursor: BBB, pending: [] });
	});

	test("Livespec merge is not suggested", async () => {
		const git = history(AAA, [{ sha: BBB, subject: "feat: cap (#41)", paths: ["src/limit/cap.ts"] }]);
		const forge = forgeOf([pullRequest(41, "livespec/rate-cap", "")]);
		expect(await scanState(deps(git, forge), { cursor: AAA, pending: [] })).toEqual({ cursor: BBB, pending: [] });
	});

	test("a fix merge is not suggested; a pull request from another branch is", async () => {
		const ccc = sha("c");
		const git = history(AAA, [
			{ sha: BBB, subject: "Merge pull request #7 from acme/fix/tweak", paths: ["src/limit/cap.ts"] },
			{ sha: ccc, subject: "feat: cache (#8)", paths: ["src/cache/store.ts", "src/limit/cap.ts"] },
		]);
		const forge = forgeOf([pullRequest(7, "fix/tweak", ""), pullRequest(8, "feature/cache", "")]);
		const next = await scanState(deps(git, forge), { cursor: AAA, pending: [] });
		expect(next).toEqual({ cursor: ccc, pending: [{ kind: "commit", sha: ccc, capabilities: ["cache", "rate-limit"] }] });
	});

	test("More than 50 commits", async () => {
		const commits = Array.from({ length: 60 }, (_, i): FakeCommit => {
			const id = `c${String(i + 1).padStart(39, "0")}`;
			return i + 1 === 55 ? { sha: id, subject: "manual", paths: ["src/limit/cap.ts"] } : { sha: id, subject: `docs ${i + 1}`, paths: ["README.md"] };
		});
		const git = history(AAA, commits);
		const first = await scanState(deps(git), { cursor: AAA, pending: [] });
		expect(first).toEqual({ cursor: commits[49]?.sha, pending: [] });
		const second = await scanState(deps(git), first);
		expect(second).toEqual({ cursor: commits[59]?.sha, pending: [{ kind: "commit", sha: commits[54]?.sha, capabilities: ["rate-limit"] }] });
	});

	test("forge error keeps the cursor and adds nothing", async () => {
		const ccc = sha("c");
		const git = history(AAA, [
			{ sha: BBB, subject: "manual", paths: ["src/limit/cap.ts"] },
			{ sha: ccc, subject: "feat: cap (#41)", paths: ["src/limit/cap.ts"] },
		]);
		const failing = { getPullRequest: async () => Promise.reject(new ForgeError({ code: "unreachable", operation: "getPullRequest", message: "down" })) };
		const state: AuditState = { cursor: AAA, pending: [] };
		const r = await scanCommits(deps(git, failing), state);
		expect(r.state).toEqual(state);
		expect(r.error).toBeInstanceOf(ForgeError);
	});

	test("without a forge the cursor does not move", async () => {
		const git = history(AAA, [{ sha: BBB, subject: "manual", paths: ["src/limit/cap.ts"] }]);
		const state: AuditState = { cursor: AAA, pending: [] };
		expect(await scanState({ git, tip: git.tip, specs: SPECS }, state)).toEqual(state);
	});

	test("one forge read per pull request number", async () => {
		const ccc = sha("c");
		const git = history(AAA, [
			{ sha: BBB, subject: "feat: cap (#41)", paths: ["src/limit/cap.ts"] },
			{ sha: ccc, subject: "revert: cap (#41)", paths: ["src/limit/cap.ts"] },
		]);
		const reads: number[] = [];
		const inner = forgeOf([pullRequest(41, "livespec/rate-cap", "")]);
		const forge = { getPullRequest: (n: number) => (reads.push(n), inner.getPullRequest(n)) };
		await scanState(deps(git, forge), { cursor: AAA, pending: [] });
		expect(reads).toEqual([41]);
	});

	test("a commit already pending is not added twice", async () => {
		const git = history(AAA, [{ sha: BBB, subject: "manual", paths: ["src/limit/cap.ts"] }]);
		const pending = [{ kind: "commit" as const, sha: BBB, capabilities: ["rate-limit"] }];
		expect(await scanState(deps(git), { cursor: AAA, pending })).toEqual({ cursor: BBB, pending });
	});

	test("manual --no-ff merge", async () => {
		const root = await makeRepo();
		const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
		await writeIn(root, "README.md", "x\n");
		commitAll(root);
		run("branch", "-M", "main");
		const start = run("rev-parse", "HEAD");
		run("switch", "-q", "-c", "side");
		await writeIn(root, "src/limit/cap.ts", "export const cap = 1;\n");
		commitAll(root, "cap");
		run("switch", "-q", "main");
		run("-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", "Merge branch 'side'", "side");
		const merge = run("rev-parse", "HEAD");
		run("update-ref", "refs/remotes/origin/main", merge);
		const next = await scanState({ git: createGit(root), forge: forgeOf([]), tip: merge, specs: SPECS }, { cursor: start, pending: [] });
		expect(next).toEqual({ cursor: merge, pending: [{ kind: "commit", sha: merge, capabilities: ["rate-limit"] }] });
	});

	test("a commitPaths error keeps the cursor and is returned", async () => {
		const git = { ...history(AAA, [{ sha: BBB, subject: "manual", paths: [] }]), commitPaths: async () => Promise.reject(new Error("bad object")) };
		const state: AuditState = { cursor: AAA, pending: [] };
		const r = await scanCommits(deps(git), state);
		expect(r).toEqual({ state, error: new Error("bad object") });
	});
});

describe("addInitiative", () => {
	test("Initiative closed", () => {
		const next = addInitiative({ pending: [] }, 30);
		expect(next).toEqual({ pending: [{ kind: "initiative", initiative: 30 }] });
		expect(pendingReasons(next)).toEqual(["initiative #30 closed"]);
		expect(addInitiative(next, 30)).toEqual(next);
	});
});

describe("completeAudit", () => {
	const ok = (commit: string, o: { posted?: number; fixesRan: boolean }) => ({ ok: true as const, text: "", commit, ...o });
	const ancestry = (ancestors: Set<string>) => async (a: string, _b: string) => ancestors.has(a);

	test("Audit clears covered suggestions", async () => {
		const ccc = sha("c");
		const state: AuditState = {
			cursor: BBB,
			pending: [
				{ kind: "initiative", initiative: 30 },
				{ kind: "commit", sha: BBB, capabilities: ["rate-limit"] },
				{ kind: "initiative", initiative: 31 },
			],
		};
		const next = await completeAudit(state, ok(ccc, { posted: 30, fixesRan: true }), ancestry(new Set([BBB])));
		expect(next).toEqual({ cursor: BBB, fixCursor: ccc, auditedCommit: ccc, pending: [{ kind: "initiative", initiative: 31 }] });
		expect(pendingReasons(next)).toEqual(["initiative #31 closed"]);
	});

	test("a commit not in the audited commit stays pending; an unknown commit too", async () => {
		const ddd = sha("d");
		const state: AuditState = { pending: [{ kind: "commit", sha: BBB, capabilities: ["cache"] }, { kind: "commit", sha: ddd, capabilities: ["cache"] }] };
		const isAncestor = async (a: string) => {
			if (a === ddd) throw new Error("unknown object");
			return false;
		};
		const next = await completeAudit(state, ok(AAA, { fixesRan: true }), isAncestor);
		expect(next.pending).toEqual(state.pending);
	});

	test("Skipped fix detector keeps the fix cursor", async () => {
		const state: AuditState = { fixCursor: BBB, pending: [] };
		expect(await completeAudit(state, ok(AAA, { fixesRan: false }), ancestry(new Set()))).toEqual({ fixCursor: BBB, auditedCommit: AAA, pending: [] });
	});

	test("Fix merged during the audit", async () => {
		// The audit fetched `aaa`; fix pull request #50 merged later, so its commit is not in `aaa`.
		const next = await completeAudit({ pending: [] }, ok(AAA, { fixesRan: true }), ancestry(new Set()));
		expect(next.fixCursor).toBe(AAA);
		expect(next.auditedCommit).toBe(AAA);
	});
});

describe("pendingReasons", () => {
	test("several capabilities are listed", () => {
		expect(pendingReasons({ pending: [{ kind: "commit", sha: BBB, capabilities: ["cache", "rate-limit"] }] })).toEqual([`commit ${BBB.slice(0, 7)} touches cache, rate-limit`]);
	});
});

const LIMIT_SPEC = "---\npaths:\n  - src/limit/**\n---\n# rate-limit\n\n## Purpose\n\nLimits.\n\n## Requirements\n\n### Requirement: Cap\nThe system SHALL cap.\n\n#### Scenario: caps\n- **WHEN** too many\n- **THEN** rejected\n";
const PROJECT = { githubHosts: [], agentSkillsChannelSet: false, integrationBranch: "main" };

/** A repo on `main` with the rate-limit spec; `origin/main` at HEAD. */
async function specRepo(): Promise<{ root: string; run: (...args: string[]) => string; publish: () => string }> {
	const root = await makeRepo();
	const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	await writeIn(root, "specs/rate-limit/spec.md", LIMIT_SPEC);
	commitAll(root);
	run("branch", "-M", "main");
	const publish = () => {
		const head = run("rev-parse", "HEAD");
		run("update-ref", "refs/remotes/origin/main", head);
		return head;
	};
	publish();
	return { root, run, publish };
}

describe("suggestAtStart", () => {
	test("specs and commits come from one integration snapshot", async () => {
		const { root, run, publish } = await specRepo();
		const base = run("rev-parse", "HEAD");
		await writeAuditState(createGit(root), { cursor: base, pending: [] });
		await writeIn(root, "src/limit/cap.ts", "1\n");
		commitAll(root, "a: limit");
		const a = publish();
		// B moves the cache capability's spec in and touches it; specs read at A do not know `cache`.
		await writeIn(root, "specs/cache/spec.md", LIMIT_SPEC.replace("src/limit/**", "src/cache/**").replace("# rate-limit", "# cache"));
		await writeIn(root, "src/cache/store.ts", "1\n");
		commitAll(root, "b: cache");
		const b = run("rev-parse", "HEAD");
		const real = createGit(root);
		let reads = 0;
		const git = {
			...real,
			remoteRef: async (name: string) => {
				const at = await real.remoteRef(name);
				if (reads++ === 0) run("update-ref", "refs/remotes/origin/main", b); // another worktree fetches B now
				return at;
			},
		};
		const r = await suggestAtStart({ git, forge: forgeOf([]), project: PROJECT });
		expect(r.error).toBeUndefined();
		expect(r.state.cursor).toBe(a);
		expect(r.state.pending).toEqual([{ kind: "commit", sha: a, capabilities: ["rate-limit"] }]);
		const next = await suggestAtStart({ git: real, forge: forgeOf([]), project: PROJECT });
		expect(next.state.cursor).toBe(b);
		expect(next.state.pending.map((p) => (p.kind === "commit" ? p.capabilities : []))).toEqual([["rate-limit"], ["cache"]]);
	});

	test("a scan error is returned and the cursor is unchanged", async () => {
		const { root, run, publish } = await specRepo();
		const base = run("rev-parse", "HEAD");
		await writeAuditState(createGit(root), { cursor: base, pending: [] });
		await writeIn(root, "src/limit/cap.ts", "1\n");
		commitAll(root, "feat: cap (#41)");
		publish();
		const failing = { getPullRequest: async () => Promise.reject(new ForgeError({ code: "unreachable", operation: "getPullRequest", message: "down" })) };
		const r = await suggestAtStart({ git: createGit(root), forge: failing, project: PROJECT });
		expect(r.error).toBeInstanceOf(ForgeError);
		expect(r.state).toEqual({ cursor: base, pending: [] });
		expect(await readAuditState(createGit(root))).toEqual({ cursor: base, pending: [] });
	});

	test("an initiative stored while the scan runs is kept", async () => {
		const { root, run, publish } = await specRepo();
		const git = createGit(root);
		const base = run("rev-parse", "HEAD");
		await writeAuditState(git, { cursor: base, pending: [] });
		await writeIn(root, "src/limit/cap.ts", "1\n");
		commitAll(root, "feat: cap (#41)");
		const a = publish();
		const forge = {
			getPullRequest: async (n: number) => {
				await initiativeAndSave(git, 31); // the listener fires mid-scan
				return pullRequest(n, "feature/cap", "");
			},
		};
		const r = await suggestAtStart({ git, forge, project: PROJECT });
		const expected: AuditState = { cursor: a, pending: [{ kind: "initiative", initiative: 31 }, { kind: "commit", sha: a, capabilities: ["rate-limit"] }] };
		expect(r.state).toEqual(expected);
		expect(await readAuditState(git)).toEqual(expected);
	});
});

describe("auditAndSave", () => {
	test("an initiative stored while the ancestry is read is kept", async () => {
		const { root } = await specRepo();
		const real = createGit(root);
		await writeAuditState(real, { pending: [{ kind: "initiative", initiative: 30 }, { kind: "commit", sha: BBB, capabilities: ["rate-limit"] }] });
		const git = {
			commonDir: () => real.commonDir(),
			isAncestor: async () => {
				await initiativeAndSave(real, 31);
				return true;
			},
		};
		const next = await auditAndSave(git, { ok: true, text: "", commit: AAA, posted: 30, fixesRan: true });
		const expected: AuditState = { fixCursor: AAA, auditedCommit: AAA, pending: [{ kind: "initiative", initiative: 31 }] };
		expect(next).toEqual(expected);
		expect(await readAuditState(real)).toEqual(expected);
	});
});
