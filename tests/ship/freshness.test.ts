import { describe, expect, test } from "vitest";
import { gateDigest } from "../../src/engine/locks.ts";
import type { Comment, Forge } from "../../src/forge/types.ts";
import { humanThreadComments, shipStale } from "../../src/ship/freshness.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";

const comment = (id: string, createdAt: string, updatedAt = createdAt, author = "human", body = "hi"): Comment => ({ id, author, body, createdAt, updatedAt, version: "v" as Comment["version"] });
const MARKED = "<!-- livespec:gate:x -->\n```yaml\na: 1\n```";
const GATE = comment("g1", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z", "me", MARKED);

function shipState(digest = gateDigest(FIXTURE_BODY)) {
	const gate = { outcome: "approved" as const, superseded: false, at: "", waivers: [], notes: "", request: "r1", commentId: "g1" };
	return stateFor("ship", {
		lock: { locked: undefined, frozen: [], staleUnits: [], gates: { ship: gate } },
		marked: [{ commentId: "q1", kind: "request", id: "r1", author: "me", data: { gate_digest: digest } }],
	});
}

describe("shipStale", () => {
	test("the forge approval comment created before the gate comment is fresh", () => {
		expect(shipStale(shipState(), GATE, [comment("a1", "2026-01-01T00:00:00Z")])).toBeUndefined();
	});
	test("a human comment created after the gate comment is stale", () => {
		expect(shipStale(shipState(), GATE, [comment("a2", "2026-01-03T00:00:00Z")])).toContain("a2");
	});
	test("a human comment edited after the gate comment is stale", () => {
		expect(shipStale(shipState(), GATE, [comment("a1", "2026-01-01T00:00:00Z", "2026-01-04T00:00:00Z")])).toContain("a1");
	});
	test("a different issue digest is stale", () => {
		expect(shipStale(shipState("0".repeat(64)), GATE, [])).toContain("changed");
	});
	test("an in-session approval reads the digest from the answer record", () => {
		const gate = { outcome: "approved" as const, superseded: false, at: "", waivers: [], notes: "", request: "r1", commentId: "g1" };
		const answer = { commentId: "a9", kind: "answer", id: "r1", author: "me", data: { request: { gate_digest: gateDigest(FIXTURE_BODY) } } };
		const state = stateFor("ship", { lock: { locked: undefined, frozen: [], staleUnits: [], gates: { ship: gate } }, marked: [answer] });
		expect(shipStale(state, GATE, [])).toBeUndefined();
	});
	test("a missing gate comment or request record names the ship gate", () => {
		expect(shipStale(shipState(), undefined, [])).toContain("ship gate");
		expect(shipStale(stateFor("ship"), GATE, [])).toContain("ship gate");
	});
});

describe("humanThreadComments", () => {
	test("own ship and stale comments after the gate comment do not count as new input", async () => {
		const ship = comment("s1", "2026-01-05T00:00:00Z", "2026-01-05T00:00:00Z", "me", MARKED);
		const stale = comment("s2", "2026-01-06T00:00:00Z", "2026-01-06T00:00:00Z", "me", MARKED);
		const human = comment("h1", "2026-01-01T00:00:00Z");
		const forge = { listComments: async () => [human, GATE, ship, stale] } as unknown as Forge;
		const humans = await humanThreadComments(forge, 7, "me");
		expect(humans.map((c) => c.id)).toEqual(["h1"]);
		expect(shipStale(shipState(), GATE, humans)).toBeUndefined();
	});
	test("keeps own plain comments", async () => {
		const plain = comment("2", "t", "t", "me", "plain");
		const forge = { listComments: async () => [plain] } as unknown as Forge;
		expect((await humanThreadComments(forge, 7, "me")).map((c) => c.id)).toEqual(["2"]);
	});
});
