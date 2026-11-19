// Tests of the freshness check before a unit finishes.
import { afterEach, describe, expect, test } from "vitest";
import { receiptComment } from "../../src/evidence/records.ts";
import { checkFreshness, readCurrent } from "../../src/subagents/freshness.ts";
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

	test("a source whose version changed stops", () => {
		const packet = { text: "", hash: "h", sources: [{ id: "file:specs/constraints.md", version: "a", required: true }], skillPaths: [], cwd: "/", seen: [] };
		expect(checkFreshness(packet, { sources: [{ id: "file:specs/constraints.md", version: "b" }], humanComments: [] }).stale).toEqual(["file:specs/constraints.md"]);
	});
});
