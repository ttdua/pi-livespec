// `/livespec next` polls approvals, then pull request feedback, before reporting the next step.
import { afterEach, describe, expect, test, vi } from "vitest";
import { runNextCommand } from "../../src/commands/next.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import * as poll from "../../src/interaction/poll.ts";
import * as cascade from "../../src/interaction/spec-cascade.ts";
import * as feedback from "../../src/ship/feedback-poll.ts";
import { cleanupDirs, toolHarness } from "../tools/helpers.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	setSession(undefined);
	await cleanupDirs();
});

describe("/livespec next", () => {
	test("runs the spec cascade after approvals, then polls feedback", async () => {
		const order: string[] = [];
		vi.spyOn(poll, "pollApprovals").mockImplementation(async () => void order.push("approvals"));
		vi.spyOn(cascade, "runSpecCascade").mockImplementation(async () => (order.push("cascade"), false));
		vi.spyOn(feedback, "pollFeedback").mockImplementation(async () => (order.push("feedback"), { skipped: true }));
		const h = await toolHarness({ branch: "scratch" });
		await runNextCommand(h.session);
		expect(order).toEqual(["approvals", "cascade", "feedback"]);
	});
});
