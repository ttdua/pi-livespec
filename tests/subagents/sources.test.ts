// Tests of the context manifest per role and subject.
import { afterEach, describe, expect, test } from "vitest";
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
