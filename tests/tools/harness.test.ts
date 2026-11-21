import { afterEach, describe, expect, test } from "vitest";
import { cleanupDirs, toolHarness } from "./helpers.ts";

afterEach(cleanupDirs);

describe("toolHarness", () => {
	test("session.exec is the recording exec the session's git runs through", async () => {
		const h = await toolHarness();
		const before = h.gitCalls.length;
		await h.session.exec(["rev-parse", "HEAD"], { cwd: h.root });
		expect(h.gitCalls.slice(before)).toEqual([["rev-parse", "HEAD"]]);
	});

	test("the fake pi has an events bus", async () => {
		const h = await toolHarness();
		const api = h.pi.api as unknown as { events: { emit: (...a: unknown[]) => void; on: unknown } };
		api.events.emit("livespec:x", { a: 1 });
		expect(api.events.emit).toHaveBeenCalledWith("livespec:x", { a: 1 });
		expect(typeof api.events.on).toBe("function");
	});
});
