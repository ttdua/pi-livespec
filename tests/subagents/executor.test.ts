// Tests executor service lookup by capability and launch-facts parsing.
import { afterEach, describe, expect, test } from "vitest";
import { findExecutor, parseLaunchFacts, SERVICE_KEYS } from "../../src/subagents/executor.ts";

const NEW_KEY = Symbol.for("@ttdua/pi-subagents:service");
const LEGACY_KEY = Symbol.for("@gotgenes/pi-subagents:service");

/** A service with every capability; a test removes one to model an older executor. */
function fullService(): Record<string, unknown> {
	return {
		spawn: () => "id",
		wait: async () => ({ id: "id", status: "done" }),
		resume: async () => undefined,
		abort: () => true,
		childSession: () => undefined,
		getAgentType: () => undefined,
	};
}

function publish(key: symbol, service: Record<string, unknown> | undefined): void {
	Reflect.set(globalThis, key, service);
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, NEW_KEY);
	Reflect.deleteProperty(globalThis, LEGACY_KEY);
});

describe("findExecutor", () => {
	test("reports missing capabilities", () => {
		const service = fullService();
		delete service.wait;
		publish(NEW_KEY, service);
		expect(findExecutor()).toEqual({ ok: false, missing: ["wait"] });
	});

	test("ignores implementation name", () => {
		publish(NEW_KEY, { ...fullService(), name: "some-other-fork", version: "9.9.9" });
		const found = findExecutor();
		expect(found.ok).toBe(true);
	});

	test("reads the new key", () => {
		publish(NEW_KEY, fullService());
		const found = findExecutor();
		expect(found).toMatchObject({ ok: true, key: "@ttdua/pi-subagents:service" });
	});

	test("falls back to the legacy key", () => {
		publish(LEGACY_KEY, fullService());
		const found = findExecutor();
		expect(found).toMatchObject({ ok: true, key: "@gotgenes/pi-subagents:service" });
	});

	test("prefers the new key when both are published", () => {
		publish(NEW_KEY, fullService());
		publish(LEGACY_KEY, fullService());
		expect(findExecutor()).toMatchObject({ ok: true, key: "@ttdua/pi-subagents:service" });
	});

	test("service keys are read in the contract order", () => {
		expect(SERVICE_KEYS).toEqual(["@ttdua/pi-subagents:service", "@gotgenes/pi-subagents:service"]);
	});

	test("no service published reports every capability missing", () => {
		const found = findExecutor();
		expect(found).toEqual({ ok: false, missing: ["spawn", "wait", "resume", "abort", "childSession", "getAgentType"] });
	});
});

describe("parseLaunchFacts", () => {
	test("reads the effective fields", () => {
		const parsed = parseLaunchFacts({
			agentId: "agent-7",
			context: "fresh",
			cwd: "/work/lane",
			inheritSkills: false,
			skillPaths: ["/skills/a"],
			contextFiles: false,
			excludedExtensionPackages: ["git:github.com/obra/superpowers"],
			effectiveModel: "p/m",
			effectiveThinking: "high",
		});
		expect(parsed).toEqual({
			agentId: "agent-7",
			facts: {
				context: "fresh",
				cwd: "/work/lane",
				inheritSkills: false,
				skillPaths: ["/skills/a"],
				contextFiles: false,
				excludedExtensionPackages: ["git:github.com/obra/superpowers"],
				effectiveModel: "p/m",
				effectiveThinking: "high",
			},
		});
	});

	test("returns undefined without an agent id", () => {
		expect(parseLaunchFacts({ context: "fresh", cwd: "/w" })).toBeUndefined();
		expect(parseLaunchFacts(undefined)).toBeUndefined();
	});
});
