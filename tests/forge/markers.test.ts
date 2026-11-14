import { describe, expect, it } from "vitest";
import { ForgeError } from "../../src/forge/errors.ts";
import {
	assertOwnMarkedComment,
	parseMarked,
	readMarkedComments,
	registerKind,
	writeMarked,
} from "../../src/forge/markers.ts";
import type { Comment, Forge, Version } from "../../src/forge/types.ts";

const VERSION = "gh:2026-11-14T10:00:00Z:x" as Version;

function comment(id: string, author: string, body: string): Comment {
	return { id, author, body, createdAt: "2026-11-14T10:00:00Z", updatedAt: "2026-11-14T10:00:00Z", version: VERSION };
}

/** Stub forge: only the members the marker API calls. */
function stubForge(login: string, comments: Comment[]): Forge {
	return {
		whoami: async () => ({ login }),
		listComments: async () => comments,
	} as unknown as Forge;
}

describe("writeMarked", () => {
	it("starts with the marker line and carries one fenced yaml block", () => {
		const body = writeMarked("receipt", "u1", { ok: true });
		const lines = body.split("\n");
		expect(lines[0]).toBe("<!-- livespec:receipt:u1 -->");
		expect(body.match(/```yaml/g)).toHaveLength(1);
		expect(body).toContain("```yaml\nok: true\n```");
	});

	it("throws for an unregistered kind", () => {
		expect(() => writeMarked("no-such-kind", "u1", {})).toThrow(/no-such-kind/);
	});
});

describe("round trip", () => {
	it("parses back the data that was written", () => {
		const data = { phase: "apply", items: [1, 2], nested: { a: "b" } };
		const parsed = parseMarked(writeMarked("gate", "g1", data));
		expect(parsed).toEqual({ kind: "gate", id: "g1", data });
	});

	it("returns null for a body without a marker", () => {
		expect(parseMarked("just a plain comment")).toBeNull();
	});
});

describe("registerKind", () => {
	it("makes a new kind writable", () => {
		registerKind("review-lane");
		const body = writeMarked("review-lane", "r1", { lane: "a" });
		expect(body.split("\n")[0]).toBe("<!-- livespec:review-lane:r1 -->");
	});
});

describe("readMarkedComments", () => {
	it("returns the current account's marked comments with parsed data", async () => {
		const own = comment("c1", "naicoi", writeMarked("receipt", "u1", { n: 1 }));
		const result = await readMarkedComments(stubForge("naicoi", [own]), 7);
		expect(result.comments).toEqual([
			{ commentId: "c1", kind: "receipt", id: "u1", author: "naicoi", data: { n: 1 } },
		]);
		expect(result.warnings).toEqual([]);
	});

	it("ignores a foreign marked comment and warns with its author", async () => {
		const foreign = comment("c2", "mallory", writeMarked("gate", "g1", { approved: true }));
		const result = await readMarkedComments(stubForge("naicoi", [foreign]), 7);
		expect(result.comments).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("mallory");
	});

	it("ignores a plain comment without a warning", async () => {
		const plain = comment("c3", "naicoi", "looks good to me");
		const result = await readMarkedComments(stubForge("naicoi", [plain]), 7);
		expect(result.comments).toEqual([]);
		expect(result.warnings).toEqual([]);
	});
});

describe("assertOwnMarkedComment", () => {
	it("accepts a marked comment written by the current account", async () => {
		const own = comment("c1", "naicoi", writeMarked("receipt", "u1", {}));
		await expect(assertOwnMarkedComment(stubForge("naicoi", []), own)).resolves.toBeUndefined();
	});

	it("refuses a comment written by another account with ForgeError", async () => {
		const foreign = comment("c2", "mallory", writeMarked("receipt", "u1", {}));
		const error = await assertOwnMarkedComment(stubForge("naicoi", []), foreign).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ForgeError);
	});

	it("refuses a plain comment even from the current account", async () => {
		const plain = comment("c3", "naicoi", "hand-written note");
		await expect(assertOwnMarkedComment(stubForge("naicoi", []), plain)).rejects.toBeInstanceOf(ForgeError);
	});
});
