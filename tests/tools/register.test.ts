import { afterEach, describe, expect, test } from "vitest";
import { filterMarked, writeMarked } from "../../src/forge/markers.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { prepareRequest, requestComment } from "../../src/interaction/requests.ts";
import { registerSpecValidate } from "../../src/tools/spec-validate.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { CHANGE_BRANCH, resumeBody } from "../hooks/helpers.ts";
import { cleanupDirs, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const OPTIONS = [{ id: "A", label: "retry" }, { id: "B", label: "re-plan" }];

/** A build change with a pending stuck request that a writer answered; only a poll completes it. */
async function answeredStuck() {
	const h = await toolHarness({ branch: CHANGE_BRANCH });
	registerSpecValidate(h.pi.api as never);
	const n = await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: ["livespec", "livespec:phase/build"] });
	await h.world.postComment(n, BOT_LOGIN, writeMarked("stuck", "S1", { where: "U3", tried: [], hypothesis: "h", options: OPTIONS, recommended: "A" }));
	const r = prepareRequest({ kind: "stuck", subject: "stuck:S1", mode: "blocking", options: OPTIONS, head: h.head, body: "", snapshot: { id: "S1" }, summary: "stuck", now: new Date(Date.UTC(2026, 0, 1)) });
	await h.world.postComment(n, BOT_LOGIN, requestComment(r.id, r, "plain"));
	await h.world.setPermission("alice", "write");
	await h.world.postComment(n, "alice", "/livespec choose B");
	await h.session.refresh();
	return { ...h, n };
}

/** Every tool name registered by the harness plus `spec_validate`, read from one real registration. */
const TOOL_NAMES = ["spec_validate", "spec_status", "spec_next", "skill_note", "spec_write", "change_new", "change_start", "spec_gate", "plan_units", "unit_amend", "unit_start", "unit_finish", "spec_question", "spec_stuck", "subagent_dispatch", "subagent_answer", "subagent_packet", "subagent_record", "spec_review", "finding_rebut", "forge_read", "lane_open", "lane_merge", "docs_table", "change_ship", "change_push", "change_close"];

describe("every livespec tool polls first", () => {
	test("the list covers every registered tool", async () => {
		expect([...(await answeredStuck()).pi.tools.keys()].sort()).toEqual([...TOOL_NAMES].sort());
	});

	test.each(TOOL_NAMES)("%s", async (name) => {
		const h = await answeredStuck();
		await h.call(name, {}).catch(() => undefined);
		const answers = filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments.filter((m) => m.id === "S1-answer");
		expect(answers).toHaveLength(1);
	});
});
