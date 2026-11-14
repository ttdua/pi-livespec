import { describe, expect, it } from "vitest";
import { ForgeError } from "../../src/forge/errors.ts";
import { bodyVersion, changedFields, type ComparableIssue } from "../../src/forge/version.ts";

const base: ComparableIssue = { title: "t", body: "b", labels: ["livespec"], state: "open" };

describe("bodyVersion", () => {
	it("returns a gh-prefixed version with updatedAt and a sha256 of the body", () => {
		const v = bodyVersion("2026-11-14T10:00:00Z", "hello");
		expect(v).toMatch(/^gh:2026-11-14T10:00:00Z:[0-9a-f]{64}$/);
	});

	it("uses the rc prefix when asked for the re-read scheme", () => {
		const v = bodyVersion("2026-11-14T10:00:00Z", "hello", "rc");
		expect(v).toMatch(/^rc:2026-11-14T10:00:00Z:[0-9a-f]{64}$/);
	});

	it("differs when the body differs", () => {
		const a = bodyVersion("2026-11-14T10:00:00Z", "hello");
		const b = bodyVersion("2026-11-14T10:00:00Z", "hello!");
		expect(a).not.toBe(b);
	});

	it("differs when updatedAt differs", () => {
		const a = bodyVersion("2026-11-14T10:00:00Z", "hello");
		const b = bodyVersion("2026-11-14T10:00:01Z", "hello");
		expect(a).not.toBe(b);
	});

	it("is stable for the same inputs", () => {
		expect(bodyVersion("u", "x")).toBe(bodyVersion("u", "x"));
	});
});

describe("changedFields", () => {
	it("returns body when only the body differs", () => {
		expect(changedFields(base, { ...base, body: "other" })).toEqual(["body"]);
	});

	it("returns title when only the title differs", () => {
		expect(changedFields(base, { ...base, title: "other" })).toEqual(["title"]);
	});

	it("returns labels when only the labels differ", () => {
		expect(changedFields(base, { ...base, labels: [] })).toEqual(["labels"]);
	});

	it("returns state when only the state differs", () => {
		expect(changedFields(base, { ...base, state: "closed" })).toEqual(["state"]);
	});

	it("returns an empty list when nothing differs", () => {
		expect(changedFields(base, { ...base })).toEqual([]);
	});

	it("ignores label order", () => {
		const a = { ...base, labels: ["a", "b"] };
		expect(changedFields(a, { ...a, labels: ["b", "a"] })).toEqual([]);
	});
});

describe("ForgeError", () => {
	it("carries code, operation and status", () => {
		const err = new ForgeError({ code: "http", operation: "updateIssueBody", message: "boom", status: 500 });
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe("http");
		expect(err.operation).toBe("updateIssueBody");
		expect(err.status).toBe(500);
		expect(err.message).toBe("boom");
	});
});
