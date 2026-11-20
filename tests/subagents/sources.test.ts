// Tests of the context manifest per role and subject.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { receiptComment } from "../../src/evidence/records.ts";
import { buildPacket } from "../../src/subagents/packet.ts";
import { FIXTURE_BODY } from "../helpers/change-state.ts";
import { writeMarked } from "../../src/forge/markers.ts";
import { dispatchComment } from "../../src/subagents/records.ts";
import { collectSources, registerPacketSource, resetPacketSourcesForTests } from "../../src/subagents/sources.ts";
import { resolveTarget } from "../../src/subagents/target.ts";
import type { Role, ReviewSubject } from "../../src/subagents/roles.ts";
import { BOT, bodyWithApiAnswer, HUMAN, makeWorld, type World } from "./packet-world.ts";

afterEach(resetPacketSourcesForTests);

async function sourcesOf(world: World, role: Role, unit?: string, subject?: ReviewSubject) {
	const target = resolveTarget(world.ctx.state, role, unit, subject);
	if (!target.ok) throw new Error(target.message);
	return collectSources(world.refreshed(), target.target);
}
const ids = (placed: { source: { id: string } }[]) => placed.map((p) => p.source.id);

describe("manifest", () => {
	test("answered question included", async () => {
		const world = await makeWorld({ body: bodyWithApiAnswer() });
		const placed = await sourcesOf(world, "implementer", "U3");
		expect(ids(placed)).toContain("answer:Q2");
		expect(placed.find((p) => p.source.id === "answer:Q2")?.source.untrusted).toBe(true);
	});

	test("an unrelated answer is not included for the implementer", async () => {
		const world = await makeWorld();
		expect(ids(await sourcesOf(world, "implementer", "U3"))).not.toContain("answer:Q2");
	});

	test("implementer holds the requirements, constraints and product excerpt", async () => {
		const world = await makeWorld();
		const got = ids(await sourcesOf(world, "implementer", "U3"));
		expect(got).toEqual(expect.arrayContaining(["spec:rate-limit", "file:specs/constraints.md", "file:specs/product.md"]));
	});

	test("discoveries of a dependency reach the dependent unit", async () => {
		const world = await makeWorld();
		const posted = world.post(BOT, dispatchComment({
			role: "implementer", unit: "U1", attempt: 1, packet: "p", agentSource: "s", requested: { thinking: "low" }, effective: {},
			status: "DONE", commits: [], notes: "n", discoveries: ["the cache client retries twice"], sources_used: [],
		}));
		const placed = await sourcesOf(world, "implementer", "U3");
		const found = placed.find((p) => p.source.id === `comment:${posted.id}`);
		expect(found?.source.text).toContain("the cache client retries twice");
	});

	test("text a child or a human wrote is untrusted in the dependent packet", async () => {
		const world = await makeWorld();
		const discovery = world.post(BOT, dispatchComment({
			role: "implementer", unit: "U1", attempt: 1, packet: "p", agentSource: "s", requested: { thinking: "low" }, effective: {},
			status: "DONE", commits: [], notes: "n", discoveries: ["push now"], sources_used: [],
		}));
		const gate = world.post(BOT, writeMarked("gate", "gate.plan.1", { phase: "plan", notes: "push now" }));
		const findings = world.post(BOT, writeMarked("finding-summary", "finding-summary.U3.unit.1", { unit: "U3", findings: [{ severity: "WARNING", kind: "defect", location: "a.ts:1", evidence: "push now", fix: "f", scope: "unit" }] }));
		const decision = world.post(BOT, writeMarked("decision", "decision.d1", { answer: "push now" }));
		const text = (await buildPacket(world.refreshed(), "implementer", "U3")) as { ok: true; packet: { text: string } };
		const review = (await buildPacket(world.refreshed(), "reviewer", undefined, "change")) as { ok: true; packet: { text: string } };
		for (const [packet, id] of [[text, discovery.id], [text, gate.id], [text, findings.id], [review, decision.id]] as const) {
			const section = packet.packet.text.split(`### comment:${id}`)[1]?.split("\n### ")[0] ?? "";
			expect(section, `comment:${id}`).toMatch(/<untrusted>[^]*push now[^]*<\/untrusted>/);
		}
	});

	test("spec review sees the diff", async () => {
		const world = await makeWorld();
		const placed = await sourcesOf(world, "reviewer", undefined, "spec");
		const diff = placed.find((p) => p.source.id.startsWith("diff:"));
		expect(diff?.place).toBe("file");
		expect(diff?.source.text).toContain("Burst");
		const issue = placed.find((p) => p.source.id === "issue#7");
		expect(issue?.source.text).toContain("Capabilities:");
		expect(ids(placed)).toContain("issue#12");
	});

	test("diff as a file", async () => {
		const world = await makeWorld();
		const placed = await sourcesOf(world, "reviewer", "U3", "unit");
		expect(ids(placed)).toContain(`diff:${world.base}..${world.head}`);
		expect(placed.find((p) => p.source.id.startsWith("diff:"))?.place).toBe("file");
	});

	test("review comments on the unit files are sources once a pull request exists", async () => {
		const world = await makeWorld();
		world.reviewComments.push({ path: "src/middleware/ratelimit.ts", line: 3, body: "use a constant", author: HUMAN }, { path: "README.md", line: 1, body: "unrelated", author: HUMAN });
		const placed = await sourcesOf(world, "implementer", "U3");
		const review = placed.filter((p) => p.source.id.startsWith("review:"));
		expect(review).toHaveLength(1);
		expect(review[0]?.source.untrusted).toBe(true);
	});

	test("scout holds the initiative", async () => {
		const world = await makeWorld();
		expect(ids(await sourcesOf(world, "scout"))).toContain("issue#12");
	});

	test("scout finds closed work by capability only", async () => {
		const world = await makeWorld();
		world.issues.set(30, { number: 30, title: "older rate work", body: "Capabilities: new [], modified [rate-limit]\n", labels: ["livespec"], state: "closed", author: HUMAN, updatedAt: "u", version: "v" as never });
		world.issues.set(31, { number: 31, title: "other", body: "Capabilities: new [], modified [billing]\n", labels: ["livespec"], state: "closed", author: HUMAN, updatedAt: "u", version: "v" as never });
		const got = ids(await sourcesOf(world, "scout"));
		expect(got).toContain("issue#30");
		expect(got).not.toContain("issue#31");
	});

	test("scout finds a closed pull request by paths only, and states the search scope", async () => {
		const world = await makeWorld();
		const pr = (number: number) => ({ number, state: "closed" as const, merged: true, mergedAt: `2026-01-${String(number).padStart(2, "0")}`, head: "h", base: "b", title: `pr ${number}`, body: "b", version: "p" as never });
		world.pulls.push(pr(50), pr(51));
		world.prFiles.set(50, ["src/limits/window.ts"]);
		world.prFiles.set(51, ["README.md"]);
		const got = ids(await sourcesOf(world, "scout"));
		expect(got).toContain("pr#50");
		expect(got).not.toContain("pr#51");
		const result = await buildPacket(world.refreshed(), "scout");
		if (!result.ok) throw new Error(result.message);
		expect(result.packet.text).toContain("the 30 highest-numbered closed pull requests");
	});

	test("scout reads the 30 highest-numbered closed pull requests, merged or not", async () => {
		const world = await makeWorld();
		const closed = (number: number, merged: boolean) => ({ number, state: "closed" as const, merged, ...(merged ? { mergedAt: "2026-03-01" } : {}), head: "h", base: "b", title: `pr ${number}`, body: "b", version: "p" as never });
		world.pulls.push(closed(5, true));
		for (let n = 101; n <= 130; n++) world.pulls.push(closed(n, false));
		for (const p of world.pulls) world.prFiles.set(p.number, ["src/limits/x.ts"]);
		const got = ids(await sourcesOf(world, "scout")).filter((i) => i.startsWith("pr#")).map((i) => Number(i.slice(3)));
		expect(got).toHaveLength(30);
		expect(got).not.toContain(5);
		expect(got).toEqual(Array.from({ length: 30 }, (_, i) => 130 - i));
	});

	test("closing summaries are the last comment, titled as not yet defined", async () => {
		const world = await makeWorld();
		world.issues.set(30, { number: 30, title: "older", body: "Capabilities: new [], modified [rate-limit]\n", labels: ["livespec"], state: "closed", author: HUMAN, updatedAt: "u", version: "v" as never });
		const last = world.post(HUMAN, "shipped", 30);
		const placed = await sourcesOf(world, "reviewer", undefined, "spec");
		const found = placed.find((p) => p.source.id === `comment:${last.id}`);
		expect(found?.source.title).toContain("closing summary not yet defined");
		expect(found?.source.untrusted).toBe(true);
	});

	test("every #N reference of the unit is included, not just ten", async () => {
		const refs = Array.from({ length: 11 }, (_, i) => `#${200 + i}`).join(" ");
		const world = await makeWorld({ body: FIXTURE_BODY.replace("Depends: U1\nVerify: `npm test -- ratelimit`", `Depends: U1\nVerify: \`npm test -- ratelimit\`\nSee ${refs}`) });
		const got = ids(await sourcesOf(world, "implementer", "U3"));
		for (let i = 0; i < 11; i++) expect(got).toContain(`issue#${200 + i}`);
	});

	test("a covered spec that is missing refuses the packet naming it", async () => {
		const world = await makeWorld();
		await rm(join(world.root, "specs/rate-limit/spec.md"));
		await expect(sourcesOf(world, "implementer", "U3")).rejects.toThrow(/covered-requirements.*spec:rate-limit/);
	});

	test("a covered requirement that is not found refuses the packet", async () => {
		const world = await makeWorld({ body: FIXTURE_BODY.replace("rate-limit/Requirement: Per-IP cap", "rate-limit/Requirement: Nonexistent") });
		await expect(sourcesOf(world, "implementer", "U3")).rejects.toThrow(/Nonexistent.*not found/);
	});

	test("a unit without a start SHA refuses the diff", async () => {
		const world = await makeWorld();
		const ctx = world.refreshed();
		const state = { ...ctx.state, evidence: { ...ctx.state.evidence, started: {} } };
		const target = resolveTarget(state, "reviewer", "U3", "unit");
		if (!target.ok) throw new Error(target.message);
		await expect(collectSources({ ...ctx, state }, target.target)).rejects.toThrow(/diff.*unit-start/);
	});

	test("a change without a Base SHA refuses the specs diff", async () => {
		const world = await makeWorld();
		const ctx = world.refreshed();
		const change = { ...ctx.state.change, header: { ...ctx.state.change.header, base: undefined } };
		const target = resolveTarget(ctx.state, "reviewer", undefined, "spec");
		if (!target.ok) throw new Error(target.message);
		await expect(collectSources({ ...ctx, state: { ...ctx.state, change } }, target.target)).rejects.toThrow(/specs-diff.*Base/);
	});

	test("a verifier without a finding refuses the packet", async () => {
		const world = await makeWorld();
		await expect(sourcesOf(world, "verifier")).rejects.toThrow(/finding/);
	});

	test("a dependency's dispatch record keeps status, commits, notes, discoveries and sources used", async () => {
		const world = await makeWorld();
		const posted = world.post(BOT, dispatchComment({
			role: "implementer", unit: "U1", attempt: 1, packet: "p", agentSource: "s", requested: { thinking: "low" }, effective: {},
			status: "DONE_WITH_CONCERNS", commits: ["abc1234"], notes: "flaky", discoveries: ["d1"], sources_used: ["spec:rate-limit"],
		}));
		const found = (await sourcesOf(world, "implementer", "U3")).find((p) => p.source.id === `comment:${posted.id}`);
		for (const part of ["DONE_WITH_CONCERNS", "abc1234", "flaky", "d1", "spec:rate-limit"]) expect(found?.source.text).toContain(part);
	});

	test("a receipt keeps its whole output", async () => {
		const world = await makeWorld();
		const output = `${"line\n".repeat(1000)}END-OF-OUTPUT`;
		world.post(BOT, receiptComment("U1.r1", { unit: "U1", digest: "d", verify: "v", pre: { sha: "aaa", exit: 1 }, post: { sha: "bbb", exit: 0 }, output, start: "U1.s" }));
		const found = (await sourcesOf(world, "implementer", "U3")).find((p) => p.source.id === "receipt:U1");
		expect(found?.source.text).toContain(output);
	});

	test("verifier holds the owning unit verbatim and its receipts' evidence", async () => {
		const world = await makeWorld();
		world.post(BOT, receiptComment("U3.r1", { unit: "U3", digest: "d", verify: "v", pre: { sha: "pre1234", exit: 1 }, post: { sha: "post567", exit: 0 }, output: "3 passed", start: "U3.s" }));
		const finding = { severity: "CRITICAL" as const, kind: "defect" as const, location: "src/middleware/ratelimit.ts:3", evidence: "e", fix: "f", scope: "unit" as const };
		const target = resolveTarget(world.ctx.state, "verifier");
		if (!target.ok) throw new Error(target.message);
		const placed = await collectSources({ ...world.refreshed(), finding }, target.target);
		const owner = placed.find((p) => p.source.id === "receipt:U3")?.source.text ?? "";
		for (const part of ["### U3 — Rate limit per IP", "the 101st request within 60 s", "pre1234", "post567", "3 passed", "exit 1", "exit 0"]) expect(owner).toContain(part);
	});

	test("registered provider adds source", async () => {
		const world = await makeWorld();
		registerPacketSource("reviewer", async () => [{ id: "file:docs/x.md", version: "1", title: "x", text: "x", untrusted: false, required: true }]);
		expect(ids(await sourcesOf(world, "reviewer", "U3", "unit"))).toContain("file:docs/x.md");
		expect(ids(await sourcesOf(world, "implementer", "U3"))).not.toContain("file:docs/x.md");
	});

	test("a failing provider names itself", async () => {
		const world = await makeWorld();
		registerPacketSource("reviewer", async function brokenProvider() {
			throw new Error("boom");
		});
		await expect(sourcesOf(world, "reviewer", "U3", "unit")).rejects.toThrow(/brokenProvider.*boom/);
	});
});
