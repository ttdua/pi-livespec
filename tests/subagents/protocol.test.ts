// Tests of the packet protocol text.
import { describe, expect, test } from "vitest";
import { loadPack } from "../../src/engine/pack-load.ts";
import { PROTOCOL_VERSION, protocolText } from "../../src/subagents/protocol.ts";

describe("protocol", () => {
	test("protocol names no default-pack skill", async () => {
		const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
		if (!loaded.ok) throw new Error("default pack must load");
		const names = loaded.pack.phases.flatMap((p) => [...p.skills.required, ...p.skills.optional]);
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) expect(protocolText()).not.toContain(name);
	});

	test("states what the spec requires", () => {
		const text = protocolText();
		for (const part of ["<untrusted>", "data", "spilled", "ask_parent", "NEEDS_CONTEXT", "submit_result", "sources_used", "discoveries"]) expect(text).toContain(part);
		expect(text).toContain(`version ${PROTOCOL_VERSION}`);
	});
});

describe("protocol v2", () => {
	test("explains optional sources", () => {
		expect(protocolText()).toContain("every required source");
		expect(protocolText()).toContain("optional");
		expect(PROTOCOL_VERSION).toBe(2);
	});
});
