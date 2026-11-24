// drift-audit "Audit suggestions": the commit scan, the initiative suggestion and the state an audit leaves.

import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { createGit } from "../../src/engine/git.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";
import { addInitiative, completeAudit, pendingReasons, scanCommits, type ScanDeps } from "../../src/audit/suggest.ts";
import type { AuditState } from "../../src/audit/state.ts";
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
function history(base: string, commits: FakeCommit[]): ScanDeps["git"] & { pathCalls: string[] } {
	const pathCalls: string[] = [];
	const tip = commits.at(-1)?.sha ?? base;
	return {
		pathCalls,
		remoteRef: async (name) => (name === "origin/main" ? tip : undefined),
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

const deps = (git: ScanDeps["git"], forge: ScanDeps["forge"] = forgeOf([])): ScanDeps => ({ git, ...(forge === undefined ? {} : { forge }), integration: "main", specs: SPECS });

describe("scanCommits", () => {
	test("first run sets the cursor only", async () => {
		const git = history(AAA, [{ sha: BBB, subject: "tweak limits", paths: ["src/limit/cap.ts"] }]);
		expect(await scanCommits(deps(git), { pending: [] })).toEqual({ cursor: BBB, pending: [] });
		expect(git.pathCalls).toEqual([]);
	});

	test("Manual commit suggests an audit", async () => {
		const git = history(AAA, [{ sha: BBB, subject: "tweak limits", paths: ["src/limit/cap.ts", "README.md"] }]);
		const next = await scanCommits(deps(git), { cursor: AAA, pending: [] });
		expect(next).toEqual({ cursor: BBB, pending: [{ kind: "commit", sha: BBB, capabilities: ["rate-limit"] }] });
		expect(pendingReasons(next)).toEqual([`commit ${BBB.slice(0, 7)} touches rate-limit`]);
	});

	test("a commit outside every capability's paths is not suggested", async () => {
		const git = history(AAA, [{ sha: BBB, subject: "docs", paths: ["README.md"] }]);
		expect(await scanCommits(deps(git), { cursor: AAA, pending: [] })).toEqual({ cursor: BBB, pending: [] });
	});

	test("Livespec merge is not suggested", async () => {
		const git = history(AAA, [{ sha: BBB, subject: "feat: cap (#41)", paths: ["src/limit/cap.ts"] }]);
		const forge = forgeOf([pullRequest(41, "livespec/rate-cap", "")]);
		expect(await scanCommits(deps(git, forge), { cursor: AAA, pending: [] })).toEqual({ cursor: BBB, pending: [] });
	});

	test("a fix merge is not suggested; a pull request from another branch is", async () => {
		const ccc = sha("c");
		const git = history(AAA, [
			{ sha: BBB, subject: "Merge pull request #7 from acme/fix/tweak", paths: ["src/limit/cap.ts"] },
			{ sha: ccc, subject: "feat: cache (#8)", paths: ["src/cache/store.ts", "src/limit/cap.ts"] },
		]);
		const forge = forgeOf([pullRequest(7, "fix/tweak", ""), pullRequest(8, "feature/cache", "")]);
		const next = await scanCommits(deps(git, forge), { cursor: AAA, pending: [] });
		expect(next).toEqual({ cursor: ccc, pending: [{ kind: "commit", sha: ccc, capabilities: ["cache", "rate-limit"] }] });
	});

	test("More than 50 commits", async () => {
		const commits = Array.from({ length: 60 }, (_, i): FakeCommit => {
			const id = `c${String(i + 1).padStart(39, "0")}`;
			return i + 1 === 55 ? { sha: id, subject: "manual", paths: ["src/limit/cap.ts"] } : { sha: id, subject: `docs ${i + 1}`, paths: ["README.md"] };
		});
		const git = history(AAA, commits);
		const first = await scanCommits(deps(git), { cursor: AAA, pending: [] });
		expect(first).toEqual({ cursor: commits[49]?.sha, pending: [] });
		const second = await scanCommits(deps(git), first);
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
		expect(await scanCommits(deps(git, failing), state)).toEqual(state);
	});

	test("without a forge the cursor does not move", async () => {
		const git = history(AAA, [{ sha: BBB, subject: "manual", paths: ["src/limit/cap.ts"] }]);
		const state: AuditState = { cursor: AAA, pending: [] };
		expect(await scanCommits({ git, integration: "main", specs: SPECS }, state)).toEqual(state);
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
		await scanCommits(deps(git, forge), { cursor: AAA, pending: [] });
		expect(reads).toEqual([41]);
	});

	test("a commit already pending is not added twice", async () => {
		const git = history(AAA, [{ sha: BBB, subject: "manual", paths: ["src/limit/cap.ts"] }]);
		const pending = [{ kind: "commit" as const, sha: BBB, capabilities: ["rate-limit"] }];
		expect(await scanCommits(deps(git), { cursor: AAA, pending })).toEqual({ cursor: BBB, pending });
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
		const next = await scanCommits(deps(createGit(root)), { cursor: start, pending: [] });
		expect(next).toEqual({ cursor: merge, pending: [{ kind: "commit", sha: merge, capabilities: ["rate-limit"] }] });
	});

	test("no origin/<integration>: the state is unchanged", async () => {
		const git = history(AAA, []);
		const state: AuditState = { pending: [] };
		expect(await scanCommits({ ...deps(git), integration: "develop" }, state)).toEqual(state);
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
