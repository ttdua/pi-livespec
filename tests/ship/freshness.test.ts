import { describe, expect, test } from "vitest";
import { gateDigest } from "../../src/engine/locks.ts";
import type { Comment, Forge } from "../../src/forge/types.ts";
import { humanThreadComments, shipStale } from "../../src/ship/freshness.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";

const comment = (id: string, createdAt: string, updatedAt = createdAt, author = "human", body = "hi"): Comment => ({ id, author, body, createdAt, updatedAt, version: "v" as Comment["version"] });
const GATE = comment("g1", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z", "me", "gate");

function shipState(digest = gateDigest(FIXTURE_BODY)) {
	const gate = { outcome: "approved" as const, superseded: false, at: "", waivers: [], notes: "", request: "r1", commentId: "g1" };
	return stateFor("ship", {
		lock: { locked: undefined, frozen: [], staleUnits: [], gates: { ship: gate } },
		marked: [{ commentId: "q1", kind: "request", id: "r1", author: "me", data: { gate_digest: digest } }],
	});
}

describe("shipStale", () => {
	test("the forge approval comment created before the gate comment is fresh", () => {
		expect(shipStale(shipState(), [comment("a1", "2026-01-01T00:00:00Z"), GATE])).toBeUndefined();
	});
	test("a human comment created after the gate comment is stale", () => {
		expect(shipStale(shipState(), [GATE, comment("a2", "2026-01-03T00:00:00Z")])).toContain("a2");
	});
	test("a human comment edited after the gate comment is stale", () => {
		expect(shipStale(shipState(), [GATE, comment("a1", "2026-01-01T00:00:00Z", "2026-01-04T00:00:00Z")])).toContain("a1");
	});
	test("a different issue digest is stale", () => {
		expect(shipStale(shipState("0".repeat(64)), [GATE])).toContain("changed");
	});
	test("a missing gate comment or request record names the ship gate", () => {
		expect(shipStale(shipState(), [])).toContain("ship gate");
		expect(shipStale(stateFor("ship"), [GATE])).toContain("ship gate");
	});
});

describe("humanThreadComments", () => {
	test("drops own marked comments and keeps own plain ones", async () => {
		const own = comment("1", "t", "t", "me", "<!-- livespec:gate:x -->\n```yaml\na: 1\n```");
		const plain = comment("2", "t", "t", "me", "plain");
		const other = comment("3", "t", "t", "human", "<!-- livespec:gate:x -->\n```yaml\na: 1\n```");
		const forge = { listComments: async () => [own, plain, other] } as unknown as Forge;
		expect((await humanThreadComments(forge, 7, "me")).map((c) => c.id)).toEqual(["2", "3"]);
	});
});
