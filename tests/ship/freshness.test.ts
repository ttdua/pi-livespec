import { describe, expect, test } from "vitest";
import { gateDigest } from "../../src/engine/locks.ts";
import type { Comment } from "../../src/forge/types.ts";
import { shipStaleness, writerVoices } from "../../src/ship/freshness.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";

const comment = (id: string, createdAt: string, updatedAt = createdAt, author = "human", body = "hi"): Comment => ({ id, author, body, createdAt, updatedAt, version: "v" as Comment["version"] });
const MARKED = "<!-- livespec:gate:x -->\n```yaml\na: 1\n```";
const GATE = comment("g1", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z", "me", MARKED);

function shipState(digest = gateDigest(FIXTURE_BODY)) {
	const gate = { outcome: "approved" as const, superseded: false, at: "", waivers: [], notes: "", request: "r1", commentId: "g1" };
	return stateFor("ship", {
		lock: { locked: undefined, frozen: [], staleUnits: [], gates: { ship: gate } },
		marked: [{ source: "forge", ref: "q1", kind: "request", id: "r1", author: "me", data: { gate_digest: digest } }],
	});
}

const shipStale = (...a: Parameters<typeof shipStaleness>): string | undefined => shipStaleness(...a)?.reason;

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
		const answer = { ref: "a9", source: "forge" as const, kind: "answer", id: "r1", author: "me", data: { request: { gate_digest: gateDigest(FIXTURE_BODY) } } };
		const state = stateFor("ship", { lock: { locked: undefined, frozen: [], staleUnits: [], gates: { ship: gate } }, marked: [answer] });
		expect(shipStale(state, GATE, [])).toBeUndefined();
	});
	test("a missing gate comment or request record names the ship gate", () => {
		expect(shipStale(shipState(), undefined, [])).toContain("ship gate");
		expect(shipStale(stateFor("ship"), GATE, [])).toContain("ship gate");
	});
});

describe("writerVoices since the gate", () => {
	test("only comments after the gate comment trigger a permission lookup", async () => {
		const looked: string[] = [];
		const old = comment("o1", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "oldtimer");
		const edited = comment("e1", "2026-01-01T00:00:00Z", "2026-01-04T00:00:00Z", "editor");
		const fresh = comment("n1", "2026-01-03T00:00:00Z", "2026-01-03T00:00:00Z", "newbie");
		const out = await writerVoices([old, edited, fresh], "me", async (l) => { looked.push(l); return "write"; }, GATE);
		expect(looked.sort()).toEqual(["editor", "newbie"]);
		expect(out.map((c) => c.id)).toEqual(["e1", "n1"]);
	});
	test("an old commenter whose permission cannot be read does not block", async () => {
		const old = comment("o1", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "oldtimer");
		expect(await writerVoices([old], "me", async () => { throw new Error("boom"); }, GATE)).toEqual([]);
	});
});

describe("writerVoices", () => {
	const perms: Record<string, string> = { alice: "write", bob: "read", boss: "admin" };
	const permission = async (login: string): Promise<string> => perms[login] ?? "none";
	test("own marked comments and authors without write access do not count", async () => {
		const own = comment("s1", "2026-01-05T00:00:00Z", "2026-01-05T00:00:00Z", "me", MARKED);
		const all = [comment("h1", "t", "t", "alice"), comment("h2", "t", "t", "bob"), comment("h3", "t", "t", "boss"), own];
		expect((await writerVoices(all, "me", permission)).map((c) => c.id)).toEqual(["h1", "h3"]);
	});
	test("keeps own plain comments when the account can write", async () => {
		const plain = comment("2", "t", "t", "me", "plain");
		expect((await writerVoices([plain], "me", async () => "admin")).map((c) => c.id)).toEqual(["2"]);
	});
	test("a failed permission read rejects", async () => {
		await expect(writerVoices([comment("h1", "t", "t", "alice")], "me", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
	});
});
