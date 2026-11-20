// End-to-end tests of `spec_review` through the registered tool, with a fake executor and the memory forge.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { aggregates, latestRun, type ReviewRunData } from "../../src/review/records.ts";
import type { AggregateFinding } from "../../src/subagents/records.ts";
import type { Finding } from "../../src/subagents/roles.ts";
import { registerSpecReview, runSpecReview } from "../../src/tools/spec-review.ts";
import { asChild } from "../hooks/fake-pi.ts";
import { done, unpublish } from "../subagents/fake-executor.ts";
import { cleanupDirs, textOf } from "./helpers.ts";
import { footerIds, subagentHarness } from "./subagent-helpers.ts";
import { cardState, type UnitSpec } from "./unit-helpers.ts";

afterEach(async () => {
	unpublish();
	setSession(undefined);
	await cleanupDirs();
});

const PERSONAS = ["security-auditor", "test-engineer", "web-performance-auditor"];
const U1: UnitSpec = { id: "U1", verify: "true", files: ["src/u1.ts"] };
const U2: UnitSpec = { id: "U2", verify: "true", files: ["src/limit.ts"] };
const DEFECT: Finding = { severity: "WARNING", kind: "defect", location: "src/limit.ts:1", evidence: "off by one", fix: "use >=", scope: "out-of-scope" };

type Opts = { units?: UnitSpec[]; executor?: boolean; diff?: Record<string, string>; config?: string; phase?: string; scripts?: Record<string, string> };

/**
 * A change in `review` with every unit ticked and a committed diff after Base. The fake executor answers each
 * reviewer with `reviews(subject)` and each verifier with `verdicts(location)`, both computed at wait time.
 */
async function reviewHarness(o: Opts = {}) {
	const h = await subagentHarness({ units: o.units ?? [U1, U2], ...(o.executor === false ? {} : { executor: {} }), ...(o.config === undefined ? {} : { config: o.config }), ...(o.scripts === undefined ? {} : { scripts: o.scripts }) });
	const tree = h.session.activeTree as string;
	for (const p of PERSONAS) writeFileSync(join(tree, "agents", `${p}.md`), `# ${p}\n`);
	for (const skill of ["security-and-hardening", "performance-optimization"]) {
		mkdirSync(join(tree, "skills", skill), { recursive: true });
		writeFileSync(join(tree, "skills", skill, "SKILL.md"), `# ${skill}\n`);
	}
	await h.commit(o.diff ?? { "src/limit.ts": "export const limit = 1;\n", "src/u1.ts": "export {};\n" });
	const issue = await h.world.forge.getIssue(h.n);
	await h.world.forge.updateIssueBody(h.n, issue.body.replaceAll("- [ ] pending", "- [x] done"), issue.version);
	if (o.phase !== "build") {
		await h.world.forge.removeLabels(h.n, ["livespec:phase/build"]);
		await h.world.forge.addLabels(h.n, [`livespec:phase/${o.phase ?? "review"}`]);
	}
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
	registerSpecReview(h.pi.api as never, { home: () => h.home });
	const reviews = new Map<string, Finding[]>();
	const verdicts = new Map<string, "confirmed" | "refuted">();
	h.fake.service.wait = async (id: string) => {
		await new Promise((r) => setTimeout(r, 5));
		const spawned = h.fake.spawned.find((s) => s.id === id);
		const sources = footerIds(spawned?.prompt ?? "");
		const meta = spawned?.options.metadata ?? {};
		const base = JSON.parse(JSON.stringify(done({ sources_used: sources, commits: undefined }))) as Record<string, unknown>;
		if (meta.role === "verifier") {
			const location = /(?:WARNING|CRITICAL|SUGGESTION) \S+ at (\S+)/.exec(spawned?.prompt ?? "")?.[1] ?? "";
			return { id, status: "completed", structuredResult: { ...base, findings: [], verdict: verdicts.get(location) ?? "confirmed", reason: "checked the code" } };
		}
		return { id, status: "completed", structuredResult: { ...base, findings: reviews.get(meta.subject ?? "") ?? [] } };
	};
	const review = (signal?: AbortSignal) => h.call("spec_review", {}, signal);
	const run = async (): Promise<ReviewRunData | undefined> => latestRun(await h.marked());
	const latestAggregate = async () => aggregates(await h.marked()).at(-1);
	return { ...h, reviews, verdicts, review, run, latestAggregate };
}

const subjects = (h: Awaited<ReturnType<typeof reviewHarness>>): string[] => h.fake.spawned.filter((s) => s.options.metadata.role === "reviewer").map((s) => s.options.metadata.subject as string);

describe("spec_review end to end", () => {
	test("Round started, then a seeded defect ends with rebuild.U2.1 and U2 unticked", async () => {
		const h = await reviewHarness();
		h.reviews.set("change", [DEFECT]);
		const out = await h.review();
		expect(out.isError, textOf(out)).toBeFalsy();
		const marked = await h.marked();
		const runs = marked.filter((m) => m.kind === "review-run");
		expect(runs[0]?.data).toMatchObject({ round: 1, head: h.git("rev-parse", "HEAD"), selected: ["change"], tags: [], verify: { U1: { exit: 0, verdict: "green" }, U2: { exit: 0, verdict: "green" } }, parentFindings: [], routed: false });
		expect(runs.at(-1)?.data).toMatchObject({ round: 1, routed: true });
		expect(marked.find((m) => m.kind === "decision" && m.id === "tags.review")?.data).toMatchObject({ source: "rule", outcome: [] });
		expect(marked.find((m) => m.kind === "decision" && m.id === "finding-scope.review-1")?.data).toMatchObject({ outcome: { 0: { route: "unit", unit: "U2" } } });
		expect(marked.some((m) => m.kind === "rebuild" && m.id === "rebuild.U2.1")).toBe(true);
		expect((await h.units()).find((u) => u.id === "U2")?.done).toBe(false);
		expect(h.fake.spawned.map((s) => s.options.metadata.role)).toEqual(["reviewer", "verifier"]);
	});

	test("Review Focus 5: a second call after a routed round posts nothing", async () => {
		const h = await reviewHarness();
		await h.review();
		const before = (await h.marked()).length;
		const again = await h.review();
		expect(again.isError).toBeFalsy();
		expect(textOf(again)).toContain("already routed");
		expect(await h.marked()).toHaveLength(before);
		expect(cardState(h).step.next).not.toContain("spec_review");
	});

	test("a refuted finding is DISPUTED and spec_gate review passes", async () => {
		const h = await reviewHarness();
		h.reviews.set("change", [DEFECT]);
		h.verdicts.set("src/limit.ts:1", "refuted");
		await h.review();
		expect(await h.marked().then((m) => m.some((x) => x.kind === "rebuild"))).toBe(false);
		const gate = await h.call("spec_gate", { target: "review" });
		expect(gate.isError, textOf(gate)).toBeFalsy();
		expect((await h.ofKind("gate")).at(-1)?.data).toMatchObject({ phase: "review", head_sha: h.git("rev-parse", "HEAD") });
	});

	test("Out of scope does not block", async () => {
		const h = await reviewHarness();
		h.reviews.set("change", [{ ...DEFECT, location: "src/legacy.ts:1" }]);
		await h.review();
		expect(((await h.latestAggregate())?.data.findings[0] as AggregateFinding).route).toBe("out-of-scope");
		const gate = await h.call("spec_gate", { target: "review" });
		expect(gate.isError, textOf(gate)).toBeFalsy();
	});

	test("security persona from the diff", async () => {
		const h = await reviewHarness({ diff: { "src/auth/session.ts": "export {};\n" } });
		await h.review();
		expect(subjects(h)).toEqual(["change", "persona:security-auditor"]);
		expect((await h.run())?.tags).toEqual(["security"]);
		expect((await h.units()).every((u) => (u.tags ?? []).length === 0)).toBe(true);
	});

	test("added skip: a CRITICAL lowered-standard finding without a verifier", async () => {
		const h = await reviewHarness({ diff: { "test/limit.test.ts": 'it.skip("limits", () => {});\n' } });
		await h.review();
		const f = (await h.latestAggregate())?.data.findings[0] as AggregateFinding;
		expect(f).toMatchObject({ severity: "CRITICAL", kind: "lowered-standard", location: "test/limit.test.ts:1", verify: "skipped-parent", route: "in-change" });
		expect(h.fake.spawned.some((s) => s.options.metadata.role === "verifier")).toBe(false);
	});

	test("Red unit at review", async () => {
		const h = await reviewHarness({ units: [U1, { ...U2, verify: "exit 1" }] });
		await h.review();
		const run = (await h.marked()).find((m) => m.kind === "review-run")?.data as ReviewRunData;
		expect(run.verify.U2).toEqual({ exit: 1, verdict: "red" });
		expect(run.parentFindings).toEqual([expect.objectContaining({ severity: "CRITICAL", kind: "defect", location: "src/limit.ts:1", scope: "unit" })]);
		expect(subjects(h)).toEqual(["change"]);
	});

	test("the route stage's question is non-blocking, so the call goes on to routed: true", async () => {
		const h = await reviewHarness({ config: "integrationBranch: main\ninteraction: { adapter: [forge] }\n" });
		h.reviews.set("change", [{ ...DEFECT, scope: "needs-decision" }]);
		const out = await h.review();
		expect(out.isError, textOf(out)).toBeFalsy();
		const agg = await h.latestAggregate();
		const q = parseChange(await h.world.bodyOf(h.n)).questions;
		expect(q).toEqual([expect.objectContaining({ kind: "non-blocking", text: expect.stringContaining(`finding:${agg?.commentId}:0`) })]);
		expect((await h.run())?.routed).toBe(true);
	});

	test("three routed rounds with a unit finding make the next step spec_stuck", async () => {
		const h = await reviewHarness();
		h.reviews.set("change", [DEFECT]);
		for (let round = 1; round <= 3; round++) {
			const out = await h.review();
			expect(out.isError, textOf(out)).toBeFalsy();
			await h.commit({ "src/limit.ts": `export const limit = ${round + 1};\n` });
			const issue = await h.world.forge.getIssue(h.n);
			await h.world.forge.updateIssueBody(h.n, issue.body.replaceAll("- [ ] pending", "- [x] done"), issue.version);
			await h.session.comments?.invalidate(h.n);
			await h.session.refresh();
		}
		expect((await h.marked()).filter((m) => m.kind === "rebuild").map((m) => m.id)).toEqual(["rebuild.U2.1", "rebuild.U2.2", "rebuild.U2.3"]);
		const refused = await h.review();
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("spec_stuck");
	});

	test("Inline without an executor", async () => {
		const h = await reviewHarness({ executor: false, units: [U1, U2, { id: "U3", verify: "true", files: ["src/u3.ts"] }] });
		const out = await h.review();
		expect(out.isError, textOf(out)).toBeFalsy();
		const text = textOf(out);
		expect(text).toContain("subagent_packet reviewer change, then subagent_record reviewer change");
		expect(text).toContain("subagent_packet reviewer persona:test-engineer, then subagent_record reviewer persona:test-engineer");
		expect(h.fake.spawned).toEqual([]);
	});

	test("Reviewer packet has no other reviewer's output", async () => {
		const h = await reviewHarness({ diff: { "src/auth/session.ts": "export {};\n" } });
		h.reviews.set("change", [{ ...DEFECT, evidence: "CHANGE-REVIEWER-SECRET" }]);
		await h.review();
		const persona = h.fake.spawned.find((s) => s.options.metadata.subject === "persona:security-auditor");
		expect(persona?.prompt).not.toContain("CHANGE-REVIEWER-SECRET");
	});
});

describe("spec_review stage limit", () => {
	test("a call that hits the stage limit says so instead of ending silently", async () => {
		const h = await reviewHarness();
		const out = await runSpecReview(h.pi.api as never, h.ctx as never, { home: () => h.home }, undefined, 2);
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(textOf(out)).toContain("[start]");
		expect(textOf(out)).toContain("[review]");
		expect(textOf(out)).toContain("Stopped after 2 stages; run spec_review again to continue the round.");
		expect((await h.run())?.routed).toBe(false);
	});
});

describe("spec_review refusals write nothing", () => {
	const refusedWith = async (h: Awaited<ReturnType<typeof reviewHarness>>, text: string, ctx?: unknown) => {
		const before = (await h.marked()).length;
		const out = ctx === undefined ? await h.review() : ((await h.pi.tools.get("spec_review")?.execute("c", {}, undefined, undefined, ctx)) as { isError: boolean; content: { text: string }[] });
		expect(out.isError).toBe(true);
		expect(out.content.map((c) => c.text).join("\n")).toContain(text);
		expect(await h.marked()).toHaveLength(before);
	};

	test("child session", async () => {
		const h = await reviewHarness();
		h.fake.service.childSession = (() => ({ agentId: "agent-9", agentType: "implementer", metadata: {} })) as never;
		await refusedWith(h, "child session", asChild(h.ctx));
	});

	test("wrong phase", async () => {
		await refusedWith(await reviewHarness({ phase: "define" }), "not review");
	});

	test("Unit not done", async () => {
		const h = await reviewHarness();
		const issue = await h.world.forge.getIssue(h.n);
		await h.world.forge.updateIssueBody(h.n, issue.body.replace(/(Verify: `true`\n)- \[x\] done(\n\n## Durable)/, "$1- [ ] pending$2"), issue.version);
		await h.session.comments?.invalidate(h.n);
		await refusedWith(h, "U2");
	});

	test("No Base", async () => {
		const h = await reviewHarness();
		const issue = await h.world.forge.getIssue(h.n);
		await h.world.forge.updateIssueBody(h.n, issue.body.replace(/^Base: .*\n/m, ""), issue.version);
		await h.session.comments?.invalidate(h.n);
		await refusedWith(h, "no Base");
	});

	test("a failing git diff", async () => {
		const h = await reviewHarness();
		const issue = await h.world.forge.getIssue(h.n);
		await h.world.forge.updateIssueBody(h.n, issue.body.replace(/^Base: .*$/m, `Base: ${"0".repeat(40)}`), issue.version);
		await h.session.comments?.invalidate(h.n);
		await refusedWith(h, "git diff");
	});

	test("dirty tree", async () => {
		const h = await reviewHarness();
		writeFileSync(join(h.root, "src", "limit.ts"), "dirty\n");
		await refusedWith(h, "dirty");
	});

	test("open blocking question", async () => {
		const h = await reviewHarness();
		const issue = await h.world.forge.getIssue(h.n);
		await h.world.forge.updateIssueBody(h.n, issue.body.replace("## Questions\n", "## Questions\n- [ ] Q1 (blocking): which?\n"), issue.version);
		await h.session.comments?.invalidate(h.n);
		await refusedWith(h, "Q1");
	});

	test("unanswered stuck report", async () => {
		const h = await reviewHarness();
		await h.seed("stuck", "S1", { where: "review", tried: [], hypothesis: "h", options: [], recommended: "A" });
		await refusedWith(h, "S1");
	});

	test("pending blocking request", async () => {
		const h = await reviewHarness({ config: "integrationBranch: main\ninteraction: { adapter: [forge] }\n" });
		await h.call("spec_gate", { target: "review" }).catch(() => undefined);
		await h.call("spec_question", { text: "Which store?" });
		await refusedWith(h, "Q1");
	});

	test("cap blocking a start", async () => {
		const h = await reviewHarness({ scripts: { ".pi/livespec/flow.yaml": "extends: agent-skills\nloops: { review_rounds: 1 }\n" } });
		h.reviews.set("change", [DEFECT]);
		await h.review();
		await h.commit({ "src/limit.ts": "export const limit = 9;\n" });
		const issue = await h.world.forge.getIssue(h.n);
		await h.world.forge.updateIssueBody(h.n, issue.body.replaceAll("- [ ] pending", "- [x] done"), issue.version);
		await h.session.comments?.invalidate(h.n);
		await refusedWith(h, "spec_stuck");
	});

	test("guard-blocked Verify", async () => {
		const h = await reviewHarness({ units: [U1, { ...U2, verify: "true && git push" }] });
		await refusedWith(h, "blocked");
	});
});
