// Tests child-session detection and the fixed child note.
import { afterEach, describe, expect, test } from "vitest";
import { loadPack } from "../../src/engine/pack-load.ts";
import { CHILD_NOTE, isChildSession } from "../../src/subagents/child.ts";

const NEW_KEY = Symbol.for("@ttdua/pi-subagents:service");

type Ctx = Parameters<typeof isChildSession>[0];

/** A ctx whose header names no parent unless `parentSession` is given. */
function ctxWith(parentSession?: string): Ctx {
	return {
		sessionManager: {
			getSessionId: () => "sess-1",
			getHeader: () => (parentSession === undefined ? { type: "session", id: "sess-1" } : { type: "session", id: "sess-1", parentSession }),
		},
	} as unknown as Ctx;
}

function publishChildSession(childSession: () => unknown): void {
	Reflect.set(globalThis, NEW_KEY, {
		spawn: () => "id",
		wait: async () => ({ id: "id", status: "done" }),
		resume: async () => undefined,
		abort: () => true,
		childSession,
		getAgentType: () => undefined,
	});
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, NEW_KEY);
});

describe("isChildSession", () => {
	test("childSession returns a record: child", () => {
		publishChildSession(() => ({ agentId: "a", agentType: "general", metadata: {} }));
		expect(isChildSession(ctxWith())).toBe(true);
	});

	test("childSession undefined and no parentSession: main session", () => {
		publishChildSession(() => undefined);
		expect(isChildSession(ctxWith())).toBe(false);
	});

	test("childSession throws: child", () => {
		publishChildSession(() => {
			throw new Error("boom");
		});
		expect(isChildSession(ctxWith())).toBe(true);
	});

	test("no executor, header names a parent: child", () => {
		expect(isChildSession(ctxWith("/sessions/parent.jsonl"))).toBe(true);
	});
});

describe("CHILD_NOTE", () => {
	test("states the parent owns state and the untrusted and ask_parent rules", () => {
		expect(CHILD_NOTE).toContain("parent");
		expect(CHILD_NOTE).toContain("<untrusted>");
		expect(CHILD_NOTE).toContain("ask_parent");
	});

	test("names no default-pack skill", async () => {
		const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
		if (!loaded.ok) throw new Error("default pack must load");
		const names = loaded.pack.phases.flatMap((p) => [...p.skills.required, ...p.skills.optional]);
		for (const name of names) expect(CHILD_NOTE).not.toContain(name);
	});
});
