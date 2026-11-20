// End-to-end review (LS-08): a two-unit change reaches review, a seeded defect sends U2 back to build, and a clean round 2 passes the gate.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { setSession } from "../../src/hooks/session-store.ts";
import { latestRun } from "../../src/review/records.ts";
import type { Finding } from "../../src/subagents/roles.ts";
import { registerSpecReview } from "../../src/tools/spec-review.ts";
import { done, unpublish } from "../subagents/fake-executor.ts";
import { cleanupDirs, textOf } from "../tools/helpers.ts";
import { footerIds, subagentHarness } from "../tools/subagent-helpers.ts";
import { cardState, type UnitSpec } from "../tools/unit-helpers.ts";

afterEach(async () => {
	unpublish();
	setSession(undefined);
	await cleanupDirs();
});

const U1: UnitSpec = { id: "U1", verify: "true", files: ["src/u1.ts"] };
const U2: UnitSpec = { id: "U2", verify: "true", files: ["src/limit.ts"] };
const DEFECT: Finding = { severity: "WARNING", kind: "defect", location: "src/limit.ts:1", evidence: "off by one", fix: "use >=", scope: "out-of-scope" };
const BLOCKER: Finding = { ...DEFECT, location: "src/limit.ts:2", evidence: "swallows the error" };

test("review sends U2 back to build, the rebuild is ticked, round 2 is clean and the gate ships", async () => {
	const h = await subagentHarness({ units: [U1, U2], executor: {} });
	const tree = h.session.activeTree as string;
	for (const p of ["security-auditor", "test-engineer", "web-performance-auditor"]) writeFileSync(join(tree, "agents", `${p}.md`), `# ${p}\n`);
	for (const skill of ["security-and-hardening", "performance-optimization"]) {
		mkdirSync(join(tree, "skills", skill), { recursive: true });
		writeFileSync(join(tree, "skills", skill, "SKILL.md"), `# ${skill}\n`);
	}
	await h.commit({ "src/limit.ts": "export const limit = 1;\n", "src/u1.ts": "export {};\n" });
	const tick = async () => {
		const issue = await h.world.forge.getIssue(h.n);
		await h.world.forge.updateIssueBody(h.n, issue.body.replaceAll("- [ ] pending", "- [x] done"), issue.version);
		await h.world.forge.removeLabels(h.n, ["livespec:phase/build"]);
		await h.world.forge.addLabels(h.n, ["livespec:phase/review"]);
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
	};
	await tick();
	registerSpecReview(h.pi.api as never, { home: () => h.home });

	// Round 1: the change reviewer reports a real defect and one the verifier refutes.
	const reports: Record<number, Finding[]> = { 1: [DEFECT, BLOCKER] };
	let round = 1;
	h.fake.service.wait = async (id: string) => {
		const spawned = h.fake.spawned.find((s) => s.id === id);
		const meta = spawned?.options.metadata ?? {};
		const base = JSON.parse(JSON.stringify(done({ sources_used: footerIds(spawned?.prompt ?? ""), commits: undefined }))) as Record<string, unknown>;
		if (meta.role === "verifier") {
			const location = /(?:WARNING|CRITICAL|SUGGESTION) \S+ at (\S+)/.exec(spawned?.prompt ?? "")?.[1] ?? "";
			const verdict = location === BLOCKER.location ? "refuted" : "confirmed";
			return { id, status: "completed", structuredResult: { ...base, findings: [], verdict, reason: "checked the code" } };
		}
		return { id, status: "completed", structuredResult: { ...base, findings: reports[round] ?? [] } };
	};

	const first = await h.call("spec_review", {});
	expect(first.isError, textOf(first)).toBeFalsy();
	const marked = await h.marked();
	expect(marked.some((m) => m.kind === "rebuild" && m.id === "rebuild.U2.1")).toBe(true);
	expect((await h.units()).map((u) => [u.id, u.done])).toEqual([["U1", true], ["U2", false]]);

	// Back in build: U2 restarts green with verdict rebuild, is fixed and ticked again.
	await h.world.forge.removeLabels(h.n, ["livespec:phase/review"]);
	await h.world.forge.addLabels(h.n, ["livespec:phase/build"]);
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
	const started = await h.start("U2");
	expect(started.isError, textOf(started)).toBeFalsy();
	expect((await h.ofKind("unit-start")).at(-1)?.data).toMatchObject({ unit: "U2", pre: { verdict: "rebuild" } });
	await h.commit({ "src/limit.ts": "export const limit = 2;\n" });
	const finished = await h.call("unit_finish", { unit: "U2" });
	expect(finished.isError, textOf(finished)).toBeFalsy();
	expect((await h.ofKind("receipt")).at(-1)?.data).toMatchObject({ unit: "U2" });
	expect((await h.units()).every((u) => u.done)).toBe(true);

	// Round 2 is clean at the new HEAD.
	round = 2;
	await h.world.forge.removeLabels(h.n, ["livespec:phase/build"]);
	await h.world.forge.addLabels(h.n, ["livespec:phase/review"]);
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
	const second = await h.call("spec_review", {});
	expect(second.isError, textOf(second)).toBeFalsy();
	const head = h.git("rev-parse", "HEAD");
	expect(latestRun(await h.marked())).toMatchObject({ round: 2, head, routed: true });

	const gate = await h.call("spec_gate", { target: "review" });
	expect(gate.isError, textOf(gate)).toBeFalsy();
	expect((await h.ofKind("gate")).at(-1)?.data).toMatchObject({ phase: "review", head_sha: head });
	expect(cardState(h).state.phase).toEqual({ kind: "ok", id: "ship" });
});
