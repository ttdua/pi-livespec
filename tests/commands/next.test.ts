// `/livespec next` polls approvals, then pull request feedback, before reporting the next step.
import { afterEach, describe, expect, test, vi } from "vitest";
import { runNextCommand } from "../../src/commands/next.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import * as poll from "../../src/interaction/poll.ts";
import * as feedback from "../../src/ship/feedback-poll.ts";
import { cleanupDirs, toolHarness } from "../tools/helpers.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	setSession(undefined);
	await cleanupDirs();
});

describe("/livespec next", () => {
	test("polls feedback after approvals", async () => {
		const order: string[] = [];
		vi.spyOn(poll, "pollApprovals").mockImplementation(async () => void order.push("approvals"));
		vi.spyOn(feedback, "pollFeedback").mockImplementation(async () => (order.push("feedback"), { skipped: true }));
		const h = await toolHarness({ branch: "scratch" });
		await runNextCommand(h.session);
		expect(order).toEqual(["approvals", "feedback"]);
	});
});
