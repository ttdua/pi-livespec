// Tests of the freshness check before a unit finishes.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { receiptComment } from "../../src/evidence/records.ts";
import { stuckFor } from "../../src/subagents/finish-freshness.ts";
import { stuckReport } from "../../src/tools/spec-stuck.ts";
import { checkFreshness, readCurrent } from "../../src/subagents/freshness.ts";
import { dispatchComment } from "../../src/subagents/records.ts";
import { buildPacket } from "../../src/subagents/packet.ts";
import { resetPacketSourcesForTests } from "../../src/subagents/sources.ts";
import type { Packet } from "../../src/subagents/source-types.ts";
import { BOT, bodyWithApiAnswer, HUMAN, makeWorld, type World } from "./packet-world.ts";

afterEach(resetPacketSourcesForTests);

async function dispatched(world: World): Promise<Packet> {
	const result = await buildPacket(world.refreshed(), "implementer", "U3");
	if (!result.ok) throw new Error(result.message);
	return result.packet;
}
const stale = async (world: World, packet: Packet) => checkFreshness(packet, await readCurrent(world.refreshed(), "implementer", "U3")).stale;

describe("freshness", () => {
	test("nothing changed passes", async () => {
		const world = await makeWorld();
		expect(await stale(world, await dispatched(world))).toEqual([]);
	});

	test("new human comment stops", async () => {
		const world = await makeWorld();
		const packet = await dispatched(world);
		const comment = world.post(HUMAN, "actually use a token bucket");
		expect(await stale(world, packet)).toEqual([`comment:${comment.id}`]);
	});

	test("a new human comment on the pull request stops", async () => {
		const world = await makeWorld();
		const packet = await dispatched(world);
		const comment = world.post(HUMAN, "please rename", 41);
		expect(await stale(world, packet)).toEqual([`comment:${comment.id}`]);
	});

	test("new answer recorded by the plugin stops", async () => {
		const world = await makeWorld();
		const packet = await dispatched(world);
		world.setBody(bodyWithApiAnswer().replace("- [ ] Q1 (blocking): Which header carries the client IP behind the proxy?", "- [x] Q1 (blocking): Which header carries the client IP behind the proxy? — Answer: x-forwarded-for").replace("Q2 (non-blocking)", "Q4 (non-blocking)"));
		expect(await stale(world, packet)).toEqual(["answer:Q4"]);
	});

	test("own receipt passes", async () => {
		const world = await makeWorld();
		const packet = await dispatched(world);
		world.post(BOT, receiptComment("U1.r1", { unit: "U1", digest: "d", verify: "v", pre: { sha: "a", exit: 1 }, post: { sha: "b", exit: 0 }, output: "ok", start: "U1.s" }));
		expect(await stale(world, packet)).toEqual([]);
	});

	test("an own plain marked comment counts for nothing", async () => {
		const world = await makeWorld();
		const packet = await dispatched(world);
		world.post(BOT, "<!-- livespec:counter:x -->\n```yaml\nn: 1\n```");
		expect(await stale(world, packet)).toEqual([]);
	});

	test("a plain comment by the plugin account stops", async () => {
		const world = await makeWorld();
		const packet = await dispatched(world);
		const comment = world.post(BOT, "please also handle IPv6");
		expect(await stale(world, packet)).toEqual([`comment:${comment.id}`]);
	});

	test("a deleted source is stale", async () => {
		const world = await makeWorld();
		const packet = await dispatched(world);
		const gone = packet.sources.find((s) => s.id === "file:specs/constraints.md");
		expect(gone).toBeDefined();
		await rm(join(world.root, "specs/constraints.md"));
		expect(await stale(world, packet)).toEqual(["file:specs/constraints.md"]);
	});

	test("a newly recorded child answer stops", async () => {
		const world = await makeWorld();
		const packet = await dispatched(world);
		world.post(BOT, dispatchComment({ status: "ANSWERED", role: "implementer", unit: "U3", agentId: "agent-9", answer: "use redis" }));
		expect(await stale(world, packet)).toEqual(["answer:agent-9:1"]);
	});

	test("an answer to the dispatched child itself is not stale; another child's still is", async () => {
		const world = await makeWorld();
		const packet = await dispatched(world);
		world.post(BOT, dispatchComment({ status: "ANSWERED", role: "implementer", unit: "U3", agentId: "agent-9", answer: "use redis" }));
		const current = await readCurrent(world.refreshed(), "implementer", "U3");
		expect(checkFreshness(packet, current, "agent-9").stale).toEqual([]);
		expect(checkFreshness(packet, current, "agent-1").stale).toEqual(["answer:agent-9:1"]);
	});

	test("a comment inserted while the packet is built is stale afterwards", async () => {
		const world = await makeWorld();
		world.post(BOT, dispatchComment({ role: "implementer", unit: "U1", attempt: 1, packet: "p", agentSource: "s", requested: { thinking: "low" }, effective: {}, status: "DONE", commits: [], notes: "n", discoveries: [], sources_used: [] }));
		let late: string | undefined;
		const forge = world.forge;
		let reads = 0;
		const racing = { ...forge, listComments: async (n: number) => {
			const list = await forge.listComments(n);
			if (n === 7 && ++reads === 1) late = world.post(HUMAN, "late arrival").id;
			return list;
		} };
		const built = await buildPacket({ ...world.refreshed(), forge: racing }, "implementer", "U3");
		if (!built.ok) throw new Error(built.message);
		expect(late).toBeDefined();
		expect(await stale(world, built.packet)).toEqual([`comment:${late}`]);
	});

	test("a source whose version changed stops", () => {
		const packet = { text: "", hash: "h", sources: [{ id: "file:specs/constraints.md", version: "a", required: true }], skillPaths: [], cwd: "/", seen: [] };
		expect(checkFreshness(packet, { sources: [{ id: "file:specs/constraints.md", version: "b" }], humanComments: [] }).stale).toEqual(["file:specs/constraints.md"]);
	});
});

describe("stuckFor", () => {
	const strict = (p: ReturnType<typeof stuckFor>) => stuckReport(p, { strict: true });

	test("eight stale sources fit the hypothesis limit", () => {
		const stale = Array.from({ length: 8 }, (_, i) => `comment thread #${i + 1} on the issue changed since the dispatch of this unit and was edited again later on`);
		const p = stuckFor("U1", stale);
		expect([...p.hypothesis].length).toBeLessThanOrEqual(600);
		expect(p.hypothesis).toMatch(/and \d+ more/);
		expect(strict(p)).not.toHaveProperty("refused");
	});

	test("one very long entry is truncated", () => {
		const p = stuckFor("U1", [`unreadable: ${"x".repeat(2000)}`]);
		expect([...p.hypothesis].length).toBeLessThanOrEqual(600);
		expect(p.hypothesis).toContain("…");
		expect(strict(p)).not.toHaveProperty("refused");
	});

	test("few entries are listed whole", () => {
		const p = stuckFor("U1", ["a", "b"]);
		expect(p.hypothesis).toContain("a, b");
		expect(p.hypothesis).not.toContain("more");
	});
});

describe("stuckFor whitespace", () => {
	test("newlines in a stale entry are collapsed so the report validates", () => {
		const p = stuckFor("U1", ["unreadable: boom\n\nat line 3\n\tdeep"]);
		expect(p.hypothesis).not.toMatch(/[\r\n\t]/);
		expect(stuckReport(p, { strict: true })).not.toHaveProperty("refused");
	});
});
