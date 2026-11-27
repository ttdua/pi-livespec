// drift-audit "Audit command" and the audit routing: a real repository with a bare `origin` and a memory forge.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type AuditDeps, runAudit } from "../../src/commands/audit.ts";
import extension from "../../src/extension.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { seededFiles, laneBody } from "../audit/seeded.ts";
import { FakePi, fakeCtx } from "../hooks/fake-pi.ts";
import { gitStatus, makeRepo } from "../helpers/repo.ts";
import { fakeExecutor, unpublish } from "../subagents/fake-executor.ts";
import { cleanupDirs, originRefs, type ToolHarness, toolHarness } from "../tools/helpers.ts";

afterEach(async () => {
	unpublish();
	setSession(undefined);
	await cleanupDirs();
});

const GONE_SPEC = `---
paths:
  - src/gone/**
---
# rate-limit

## Purpose

Limits requests.

## Requirements

### Requirement: Cap
The system SHALL cap requests.

#### Scenario: caps
- **WHEN** a client sends too many requests
- **THEN** they are rejected
`;

/** A harness on `main`, with the fix commit `fix: tweak (#7)` pushed, on the feature branch `livespec/x`. */
async function seeded(): Promise<ToolHarness> {
	return toolHarness({
		files: seededFiles(),
		branch: "livespec/x",
		prepare: (git) => {
			git("commit", "-q", "--allow-empty", "-m", "fix: tweak (#7)");
			git("push", "-q", "origin", "main");
		},
	});
}

/** Issues #1..#6 (the initiative is #1) and the merged `fix/tweak` pull request #7. */
async function seedForge(h: ToolHarness): Promise<number> {
	const initiative = await h.world.seedIssue({ title: "initiative" });
	for (let i = 0; i < 5; i++) await h.world.seedIssue({ title: `other ${i}` });
	await h.world.seedPullRequest({ head: "fix/tweak", body: laneBody(["rate-limit"]), state: "closed", merged: true });
	return initiative;
}

function depsOf(h: ToolHarness, over: Partial<AuditDeps> = {}): AuditDeps {
	return {
		git: h.session.git,
		integration: "main",
		forge: h.world.forge,
		writable: true,
		state: { pending: [] },
		confirm: { events: { on: () => () => undefined }, git: h.session.git, root: h.root, exclusions: [] },
		...over,
	};
}

const SEVEN = {
	"scenario-untested:rate-limit/rejects 101st request": "major",
	"removed-reference:rate-limit/src/limit/old.ts": "major",
	"dead-paths:rate-limit:src/gone/**": "major",
	"unused-term:Bucket": "minor",
	"stale-decision:0002-x@specs/product.md": "minor",
	"product-missing:cache": "minor",
	"declared-none:pr#7:rate-limit": "major",
} as const;

describe("runAudit", () => {
	test("Read-only on files", async () => {
		const h = await seeded();
		const initiative = await seedForge(h);
		const status = gitStatus(h.root);
		const branches = h.git("branch", "--list");
		const refs = originRefs(h.origin, { ignoreLedger: true });
		const issues = await h.world.forge.searchIssues({ state: "all" });
		const out = await runAudit(depsOf(h), initiative);
		expect(out.ok).toBe(true);
		expect(gitStatus(h.root)).toEqual(status);
		expect(h.git("branch", "--list")).toBe(branches);
		expect(originRefs(h.origin, { ignoreLedger: true })).toBe(refs);
		expect(await h.world.forge.searchIssues({ state: "all" })).toHaveLength(issues.length);
		expect(await h.world.forge.listComments(initiative)).toHaveLength(1);
	});

	test("Integration snapshot, not the feature branch", async () => {
		const h = await toolHarness({ files: { "specs/rate-limit/spec.md": GONE_SPEC, "src/gone/a.ts": "export const a = 1;\n", "tests/caps.test.ts": 'it("caps", () => {});\n' }, branch: "livespec/x" });
		const other = await makeRepo();
		const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
		run(other, "clone", "-q", "-b", "main", h.origin, "w");
		const clone = join(other, "w");
		run(clone, "rm", "-q", "src/gone/a.ts");
		run(clone, "commit", "-q", "-m", "drop gone");
		run(clone, "push", "-q", "origin", "main");
		const bbb = run(clone, "rev-parse", "HEAD");
		const out = await runAudit(depsOf(h));
		expect(out.ok && out.commit).toBe(bbb);
		expect(out.text).toContain("dead-paths:rate-limit:src/gone/**");
		expect(out.text).toContain(bbb);
	});

	test("Fetch fails with a local ref", async () => {
		const h = await seeded();
		const aaa = h.git("rev-parse", "origin/main");
		h.git("remote", "set-url", "origin", "/nonexistent/origin.git");
		const out = await runAudit(depsOf(h));
		expect(out.ok && out.commit).toBe(aaa);
		expect(out.text).toMatch(/not refreshed/);
		expect(out.text).toContain("nonexistent");
	});

	test("No integration ref", async () => {
		const h = await seeded();
		const initiative = await seedForge(h);
		h.git("remote", "set-url", "origin", "/nonexistent/origin.git");
		h.git("update-ref", "-d", "refs/remotes/origin/main");
		const out = await runAudit(depsOf(h), initiative);
		expect(out.ok).toBe(false);
		expect(out.text).toContain("origin/main");
		expect(await h.world.forge.listComments(initiative)).toEqual([]);
	});

	test("Forge unavailable", async () => {
		const h = await seeded();
		await seedForge(h);
		await h.world.makeUnreachable();
		const out = await runAudit(depsOf(h));
		expect(out.ok && out.fixesRan).toBe(false);
		expect(out.text).toMatch(/declared-none skipped/);
		expect(out.text).toContain("dead-paths:rate-limit:src/gone/**");
		expect(out.text).toContain("unused-term:Bucket");
		expect(out.text).not.toContain("declared-none:pr#7");
	});

	test("Seeded audit with a confirming scout", async () => {
		const h = await seeded();
		const initiative = await seedForge(h);
		const heuristic = Object.keys(SEVEN).filter((k) => k.startsWith("scenario-untested") || k.startsWith("removed-reference"));
		const f = fakeExecutor({
			records: [{ structuredResult: { status: "DONE", notes: "ok", discoveries: [], sources_used: [], verdicts: heuristic.map((key) => ({ key, verdict: "confirmed", reason: "real" })) } }],
		});
		const out = await runAudit(depsOf(h, { confirm: { service: f.service, events: f.events, git: h.session.git, root: h.root, exclusions: [] } }), initiative);
		expect(out.ok && out.fixesRan).toBe(true);
		for (const [key, severity] of Object.entries(SEVEN)) {
			expect(out.text.split("\n").find((l) => l.includes(key))).toContain(`[${severity}]`);
		}
		expect(out.text).not.toContain("unconfirmed");
		expect(out.ok && out.posted).toBe(initiative);
		expect(f.spawned).toHaveLength(1);
	});

	test("default target is the oldest pending initiative", async () => {
		const h = await seeded();
		const initiative = await seedForge(h);
		const out = await runAudit(depsOf(h, { state: { pending: [{ kind: "commit", sha: "x", capabilities: [] }, { kind: "initiative", initiative }] } }));
		expect(out.ok && out.posted).toBe(initiative);
	});
});

describe("/livespec audit", () => {
	function load(cwd: string) {
		const pi = new FakePi();
		extension(pi.api as never);
		const ctx = fakeCtx(cwd);
		return { pi, run: (args: string) => pi.commands.get("livespec")!.handler(args, ctx) };
	}

	test("Not initialized", async () => {
		const root = await makeRepo();
		const { pi, run } = load(root);
		await run("audit");
		expect(pi.sent[0]?.content).toMatch(/not set up/);
		expect(pi.sent[0]?.content).toContain("/livespec init");
		expect(gitStatus(root)).toEqual([]);
	});

	test("Audit routed", async () => {
		const h = await seeded();
		const { pi, run } = load(h.root);
		await run("audit");
		expect(pi.sent[0]?.content).toContain("Drift report");
		expect(pi.sent[0]?.content).toContain("dead-paths:rate-limit:src/gone/**");
	});

	test("Audit scout not inline", async () => {
		const h = await seeded();
		const { pi, run } = load(h.root);
		await run("audit");
		const text = pi.sent[0]?.content ?? "";
		expect(text.split("\n").find((l) => l.includes("scenario-untested:rate-limit/rejects 101st request"))).toContain("unconfirmed");
		expect(text).not.toContain("subagent_packet");
		expect(text).not.toContain("subagent_record");
	});

	test("a bad target answers with the usage", async () => {
		const h = await seeded();
		const { pi, run } = load(h.root);
		await run("audit nope");
		expect(pi.sent[0]?.content).toContain("/livespec audit [#T]");
	});
});
