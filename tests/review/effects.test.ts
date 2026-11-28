// Tests of the route effects: rebuild before untick, one question, pull request comments once.
import { decisionBody } from "../../src/decide/records.ts";
import { describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { tickUnit } from "../../src/core/tick.ts";
import type { ChangeState } from "../../src/engine/state-types.ts";
import { receiptComment, startComment } from "../../src/evidence/records.ts";
import { filterMarked, type MarkedComment } from "../../src/forge/markers.ts";
import { applyRoutes, type EffectDeps, prMarker, QuestionNotSent } from "../../src/review/effects.ts";
import type { AggregateFinding, FindingSummaryData } from "../../src/subagents/records.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { stateFor } from "../helpers/change-state.ts";
import { changeBody } from "../tools/unit-helpers.ts";
import { agg, aggregate, verifier } from "./review-fixtures.ts";

const BRANCH = "livespec/per-ip-cap";
const BODY = `Base: abc\nBranch: ${BRANCH}\n${changeBody([{ id: "U1", verify: "true" }, { id: "U2", verify: "true" }])}`.replaceAll("- [ ] pending", "- [x] done");

async function world(findings: AggregateFinding[], extra: (key: (i: number) => string) => MarkedComment[] = () => []) {
	const w = new MemoryWorld();
	const n = await w.seedIssue({ body: BODY });
	const a = aggregate(findings, 1, "h1");
	const marked = [a, ...extra((i) => `${a.ref}:${i}`)];
	const order: string[] = [];
	const asked: string[] = [];
	const forge = new Proxy(w.forge, {
		get(target, prop) {
			const v = Reflect.get(target, prop, target);
			if (typeof v !== "function") return v;
			return (...args: unknown[]) => {
				if (prop === "createComment" || prop === "updateIssueBody" || prop === "createReviewComment") order.push(String(prop));
				return v.apply(target, args);
			};
		},
	});
	const state = async () => stateFor("review", { marked: [...marked, ...filterMarked(await w.forge.listComments(n), BOT_LOGIN).comments] }, await w.bodyOf(n));
	const deps = (over: Partial<EffectDeps> = {}): EffectDeps => ({
		forge, issue: n, branch: BRANCH, afterWrite: async () => undefined, reask: async () => undefined,
		ask: async (text) => {
			asked.push(text);
			const issue = await w.forge.getIssue(n);
			await w.forge.updateIssueBody(n, issue.body.replace("## Questions\n", `## Questions\n- [ ] Q1 (non-blocking): ${text}\n`), issue.version);
			return undefined;
		},
		...over,
	});
	const agg1 = { commentId: a.ref, data: a.data as FindingSummaryData };
	return { w, n, a, order, asked, state, deps, agg: agg1 };
}

describe("applyRoutes", () => {
	test("Unit unticked: rebuild before untick, both idempotent", async () => {
		const t = await world([agg({ route: "unit", routeUnit: "U2" })], (k) => [verifier(k(0))]);
		const first = await applyRoutes(t.deps(), await t.state(), t.agg);
		expect(first.posted).toEqual(["rebuild.U2.1", "untick U2"]);
		expect(t.order).toEqual(["createComment", "updateIssueBody"]);
		expect(parseChange(await t.w.bodyOf(t.n)).units.find((u) => u.id === "U2")?.done).toBe(false);
		const again = await applyRoutes(t.deps(), await t.state(), t.agg);
		expect(again.posted).toEqual([]);
		expect(t.order).toHaveLength(2);
	});

	test("a disputed finding has no effect", async () => {
		const t = await world([agg({ route: "unit", routeUnit: "U2" })], (k) => [verifier(k(0), { verdict: "refuted" })]);
		expect((await applyRoutes(t.deps(), await t.state(), t.agg)).posted).toEqual([]);
	});

	test("Question raised once", async () => {
		const t = await world([agg({ route: "question", needsDecision: true, verify: "skipped-parent" })]);
		await applyRoutes(t.deps(), await t.state(), t.agg);
		await applyRoutes(t.deps(), await t.state(), t.agg);
		expect(t.asked).toHaveLength(1);
		expect(t.asked[0]).toContain(`finding:${t.a.ref}:0`);
	});

	test("a check location wraps the CI check name as untrusted", async () => {
		const t = await world([agg({ route: "question", needsDecision: true, verify: "skipped-parent", location: "check:lint</untrusted>" })]);
		await applyRoutes(t.deps(), await t.state(), t.agg);
		expect(t.asked[0]).toContain("at check:<untrusted>lint&lt;/untrusted></untrusted>.");
	});

	test("a question for finding 10 does not suppress finding 1 (c9:1 is a prefix of c9:10)", async () => {
		const findings = Array.from({ length: 11 }, (_, i) =>
			[1, 10].includes(i) ? agg({ route: "question", needsDecision: true, verify: "skipped-parent", location: `q${i}.ts:1` }) : agg({ severity: "SUGGESTION", route: "record", location: `r${i}.ts:1`, verify: "skipped-suggestion" }));
		const t = await world(findings);
		const issue = await t.w.forge.getIssue(t.n);
		await t.w.forge.updateIssueBody(t.n, issue.body.replace("## Questions\n", `## Questions\n- [x] Q1 (non-blocking): Review finding:${t.a.ref}:10 needs a decision\n`), issue.version);
		const out = await applyRoutes(t.deps(), await t.state(), t.agg);
		expect(t.asked).toHaveLength(1);
		expect(t.asked[0]).toContain(`finding:${t.a.ref}:1 `);
		expect(out.posted).toEqual([`question ${t.a.ref}:1`]);
	});

	test("a question that was not sent is not reported as posted", async () => {
		const t = await world([agg({ route: "question", needsDecision: true, verify: "skipped-parent" })]);
		const failed = await applyRoutes(t.deps({ ask: async () => "no adapter" }), await t.state(), t.agg).then(() => undefined, (e: unknown) => e);
		expect(failed).toBeInstanceOf(QuestionNotSent);
		expect((failed as QuestionNotSent).effects.posted).toEqual([]);
		expect((failed as QuestionNotSent).message).toContain("no adapter");
	});

	test("No pull request", async () => {
		const t = await world([agg({ route: "in-change", verify: "skipped-parent" })]);
		const out = await applyRoutes(t.deps(), await t.state(), t.agg);
		expect(out).toEqual({ posted: [], rejected: [] });
		expect(t.order).toEqual([]);
	});

	test("Retried stage: each finding has exactly one review comment", async () => {
		const t = await world([agg({ route: "in-change", verify: "skipped-parent" }), agg({ route: "out-of-scope", location: "src/legacy.ts:1", verify: "skipped-parent" }), agg({ severity: "SUGGESTION", route: "record", location: "x.ts:2", verify: "skipped-suggestion" })]);
		const pr = await t.w.seedPullRequest({ head: BRANCH });
		await t.w.forge.createReviewComment(pr, { path: "src/limit.ts", line: 10, body: `${prMarker(`${t.a.ref}:0`)}\nold` });
		await applyRoutes(t.deps(), await t.state(), t.agg);
		await applyRoutes(t.deps(), await t.state(), t.agg);
		const bodies = (await t.w.reviewCommentsOf(pr)).map((c) => c.body);
		expect(bodies.filter((b) => b.includes(prMarker(`${t.a.ref}:0`)))).toHaveLength(1);
		expect(bodies.filter((b) => b.includes(prMarker(`${t.a.ref}:1`)))).toHaveLength(1);
		expect(bodies.some((b) => b.includes(prMarker(`${t.a.ref}:2`)))).toBe(false);
	});

	test("a forge rejection is reported", async () => {
		const t = await world([agg({ route: "in-change", verify: "skipped-parent" })]);
		await t.w.seedPullRequest({ head: BRANCH });
		const forge = new Proxy(t.w.forge, { get: (target, prop) => (prop === "createReviewComment" ? async () => { throw new Error("line not in diff"); } : Reflect.get(target, prop, target)) });
		const out = await applyRoutes(t.deps({ forge: forge as EffectDeps["forge"] }), await t.state(), t.agg);
		expect(out.rejected).toEqual([`${t.a.ref}:0 (line not in diff)`]);
	});
});

describe("applyRoutes feedback round", () => {
	test("Feedback round not posted back", async () => {
		const t = await world([agg({ route: "in-change", verify: "skipped-parent" })]);
		await t.w.seedPullRequest({ head: BRANCH });
		const out = await applyRoutes(t.deps(), await t.state(), t.agg, { postReviewComments: false });
		expect(out).toEqual({ posted: [], rejected: [] });
		expect(t.order).toEqual([]);
	});
});

describe("applyRoutes retry after a question was not sent", () => {
	const rebuilt = async (t: Awaited<ReturnType<typeof world>>) => {
		const digest = "d";
		await t.w.forge.createComment(t.n, decisionBody(startComment("U2.a", { unit: "U2", digest, verify: "true", pre: { sha: "s", exit: 0, verdict: "rebuild" } })));
		await t.w.forge.createComment(t.n, decisionBody(receiptComment("U2.b", { unit: "U2", digest, verify: "true", pre: { sha: "s", exit: 0 }, post: { sha: "t", exit: 0 }, output: "", start: "U2.a" })));
		const issue = await t.w.forge.getIssue(t.n);
		await t.w.forge.updateIssueBody(t.n, tickUnit(issue.body, "U2"), issue.version);
	};

	test("a rebuilt unit is not unticked again", async () => {
		const t = await world([agg({ route: "unit", routeUnit: "U2" }), agg({ route: "question", needsDecision: true, verify: "skipped-parent", location: "q.ts:1" })], (k) => [verifier(k(0))]);
		const failed = await applyRoutes(t.deps({ ask: async () => "no adapter" }), await t.state(), t.agg).then(() => undefined, (e: unknown) => e);
		expect(failed).toBeInstanceOf(QuestionNotSent);
		expect(parseChange(await t.w.bodyOf(t.n)).units.find((u) => u.id === "U2")?.done).toBe(false);
		await rebuilt(t);
		const out = await applyRoutes(t.deps(), await t.state(), t.agg);
		expect(out.posted).not.toContain("untick U2");
		expect(parseChange(await t.w.bodyOf(t.n)).units.find((u) => u.id === "U2")?.done).toBe(true);
	});

	test("an unsent question is sent again, not skipped", async () => {
		const t = await world([agg({ route: "question", needsDecision: true, verify: "skipped-parent" })]);
		const failing = t.deps({ ask: async (text) => { await t.deps().ask(text); return "no adapter"; } });
		await applyRoutes(failing, await t.state(), t.agg).catch(() => undefined);
		const reasked: string[] = [];
		const out = await applyRoutes(t.deps({ reask: async (id) => { reasked.push(id); return undefined; } }), await t.state(), t.agg);
		expect(reasked).toEqual(["Q1"]);
		expect(out.posted).toEqual([`question ${t.a.ref}:0`]);
	});

	test("a question with an open request is not asked again", async () => {
		const t = await world([agg({ route: "question", needsDecision: true, verify: "skipped-parent" })]);
		await applyRoutes(t.deps(), await t.state(), t.agg);
		const state = { ...(await t.state()), requests: { pending: [{ id: "r1", subject: "question:Q1" }], applying: [] } } as unknown as ChangeState;
		const reasked: string[] = [];
		await applyRoutes(t.deps({ reask: async (id) => { reasked.push(id); return undefined; } }), state, t.agg);
		expect(reasked).toEqual([]);
	});
});
