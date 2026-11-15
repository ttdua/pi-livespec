import { describe, expect, test } from "vitest";
import { ROUTING_NOTE } from "../../src/hooks/routing-note.ts";

describe("routing note", () => {
	test("Rules stated", () => {
		expect(ROUTING_NOTE).toContain("livespec");
		expect(ROUTING_NOTE).toContain("All forge writes and pushes go through livespec tools.");
		expect(ROUTING_NOTE).toContain("Updates from the integration branch are merges, never rebases.");
	});

	test("Attribution", () => {
		for (const behavior of ["Surface assumptions", "Manage confusion", "Push back when warranted", "Simplicity", "Scope discipline"]) {
			expect(ROUTING_NOTE).toContain(behavior);
		}
		expect(ROUTING_NOTE).toContain("Core Operating Behaviors adapted from agent-skills by Addy Osmani (MIT License).");
	});

	test("routing note is static text without dates or commits", () => {
		expect(ROUTING_NOTE).not.toMatch(/\b[0-9a-f]{40}\b/);
		expect(ROUTING_NOTE).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	});
});
