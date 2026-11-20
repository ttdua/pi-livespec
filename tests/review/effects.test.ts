// Tests of the route effects: rebuild before untick, one question, pull request comments once.
import { describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { filterMarked, type MarkedComment } from "../../src/forge/markers.ts";
import { applyRoutes, type EffectDeps, prMarker } from "../../src/review/effects.ts";
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
	const marked = [a, ...extra((i) => `${a.commentId}:${i}`)];
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
		forge, issue: n, branch: BRANCH, afterWrite: async () => undefined,
		ask: async (text) => {
			asked.push(text);
			const issue = await w.forge.getIssue(n);
			await w.forge.updateIssueBody(n, issue.body.replace("## Questions\n", `## Questions\n- [ ] Q1 (non-blocking): ${text}\n`), issue.version);
			return undefined;
		},
		...over,
	});
	const agg1 = { commentId: a.commentId, data: a.data as FindingSummaryData };
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
		expect(t.asked[0]).toContain(`finding:${t.a.commentId}:0`);
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
		await t.w.forge.createReviewComment(pr, { path: "src/limit.ts", line: 10, body: `${prMarker(`${t.a.commentId}:0`)}\nold` });
		await applyRoutes(t.deps(), await t.state(), t.agg);
		await applyRoutes(t.deps(), await t.state(), t.agg);
		const bodies = (await t.w.reviewCommentsOf(pr)).map((c) => c.body);
		expect(bodies.filter((b) => b.includes(prMarker(`${t.a.commentId}:0`)))).toHaveLength(1);
		expect(bodies.filter((b) => b.includes(prMarker(`${t.a.commentId}:1`)))).toHaveLength(1);
		expect(bodies.some((b) => b.includes(prMarker(`${t.a.commentId}:2`)))).toBe(false);
	});

	test("a forge rejection is reported", async () => {
		const t = await world([agg({ route: "in-change", verify: "skipped-parent" })]);
		await t.w.seedPullRequest({ head: BRANCH });
		const forge = new Proxy(t.w.forge, { get: (target, prop) => (prop === "createReviewComment" ? async () => { throw new Error("line not in diff"); } : Reflect.get(target, prop, target)) });
		const out = await applyRoutes(t.deps({ forge: forge as EffectDeps["forge"] }), await t.state(), t.agg);
		expect(out.rejected).toEqual([`${t.a.commentId}:0`]);
	});
});
