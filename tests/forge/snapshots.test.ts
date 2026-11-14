import { describe, expect, it } from "vitest";
import { SnapshotStore } from "../../src/forge/snapshots.ts";
import type { Version } from "../../src/forge/types.ts";

const v = (s: string) => s as Version;
const value = (title: string) => ({ title, body: "b", labels: ["x"], state: "open" as const });

describe("SnapshotStore", () => {
	it("recalls what it remembered, scoped by kind, number and version", () => {
		const s = new SnapshotStore();
		s.remember("issue", 1, v("a"), value("issue"));
		expect(s.recall("issue", 1, v("a"))?.title).toBe("issue");
		expect(s.recall("pull", 1, v("a"))).toBeUndefined();
		expect(s.recall("issue", 2, v("a"))).toBeUndefined();
		expect(s.recall("issue", 1, v("b"))).toBeUndefined();
	});

	it("keeps only the most recent entries up to the limit", () => {
		const s = new SnapshotStore(3);
		for (let i = 0; i < 5; i++) s.remember("issue", i, v("a"), value(`t${i}`));
		expect(s.size).toBe(3);
		expect(s.recall("issue", 0, v("a"))).toBeUndefined();
		expect(s.recall("issue", 1, v("a"))).toBeUndefined();
		expect(s.recall("issue", 4, v("a"))?.title).toBe("t4");
	});

	it("re-remembering an entry refreshes its position", () => {
		const s = new SnapshotStore(2);
		s.remember("issue", 1, v("a"), value("one"));
		s.remember("issue", 2, v("a"), value("two"));
		s.remember("issue", 1, v("a"), value("one"));
		s.remember("issue", 3, v("a"), value("three"));
		expect(s.recall("issue", 1, v("a"))).toBeDefined();
		expect(s.recall("issue", 2, v("a"))).toBeUndefined();
	});

	it("stores copies, not the caller's objects", () => {
		const s = new SnapshotStore();
		const input = value("t");
		s.remember("issue", 1, v("a"), input);
		input.labels.push("y");
		const out = s.recall("issue", 1, v("a"));
		out?.labels.push("z");
		expect(s.recall("issue", 1, v("a"))?.labels).toEqual(["x"]);
	});

	it("stores only the comparable fields", () => {
		const s = new SnapshotStore();
		s.remember("issue", 1, v("a"), { ...value("t"), author: "me" } as never);
		expect(Object.keys(s.recall("issue", 1, v("a")) ?? {}).sort()).toEqual(["body", "labels", "state", "title"]);
	});

	it("rejects a non-positive limit", () => {
		expect(() => new SnapshotStore(0)).toThrow(RangeError);
	});
});
