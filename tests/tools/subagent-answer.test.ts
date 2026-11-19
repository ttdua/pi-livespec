// Tests of `subagent_answer`: a child's question survives a reload through its record, and the answer resumes the child.
import { afterEach, describe, expect, test } from "vitest";
import { setSession } from "../../src/hooks/session-store.ts";
import { done, unpublish } from "../subagents/fake-executor.ts";
import { cleanupDirs, textOf } from "./helpers.ts";
import { footerIds, subagentHarness } from "./subagent-helpers.ts";
import { cardState } from "./unit-helpers.ts";

afterEach(async () => {
	unpublish();
	setSession(undefined);
	await cleanupDirs();
});

type H = Awaited<ReturnType<typeof subagentHarness>>;

/** Required source ids of the latest packet a child got. */
const required = (h: H): string[] => footerIds(h.fake.spawned.at(-1)?.prompt ?? "");

async function asked(question = "Which config file?") {
	const h = await subagentHarness({ executor: { records: [{ pendingQuestion: { text: question } }] } });
	const out = await h.call("subagent_dispatch", { role: "implementer", unit: "U1" });
	return { h, out };
}

describe("questions from a child", () => {
	test("ask and answer", async () => {
		const { h, out } = await asked();
		expect(textOf(out)).toContain("Child agent-1 asks: Which config file?");
		expect((await h.latest("dispatch"))?.data).toMatchObject({ status: "QUESTION", agentId: "agent-1", question: "Which config file?" });
		h.fake.records.push({ structuredResult: done({ sources_used: [...required(h), "answer:agent-1:1"] }) });
		const answered = await h.call("subagent_answer", { id: "agent-1", answer: "the project one" });
		expect(answered.isError, textOf(answered)).toBeFalsy();
		expect(h.fake.resumed).toEqual([{ id: "agent-1", prompt: "the project one" }]);
		const kinds = (await h.ofKind("dispatch")).map((m) => (m.data as { status: string }).status);
		expect(kinds).toEqual(["QUESTION", "ANSWERED", "DONE"]);
		expect((await h.latest("dispatch"))?.data).toMatchObject({ agentId: "agent-1", sources_used: expect.arrayContaining(["answer:agent-1:1"]) });
	});

	test("pending question on the card", async () => {
		const { h } = await asked();
		const { step } = cardState(h);
		expect(step.pendingChild).toEqual({ agentId: "agent-1", question: "Which config file?" });
		expect(step.next).toContain("agent-1");
		expect(step.next).toContain("Which config file?");
	});

	test("question for the user goes to spec_question", async () => {
		const { out } = await asked("Should the rate limit apply to admins?");
		expect(textOf(out)).toContain("spec_question");
		expect(textOf(out)).toContain("only the user can decide");
	});

	test("subagent_answer finds a pending child after a session reload", async () => {
		const { h } = await asked();
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		h.fake.records.push({ structuredResult: done({ sources_used: [...required(h), "answer:agent-1:1"] }) });
		const answered = await h.call("subagent_answer", { id: "agent-1", answer: "the project one" });
		expect(answered.isError, textOf(answered)).toBeFalsy();
		expect(h.fake.resumed).toHaveLength(1);
	});

	test("refuses an id with no pending question", async () => {
		const { h } = await asked();
		const before = (await h.marked()).length;
		const out = await h.call("subagent_answer", { id: "agent-9", answer: "x" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("no child agent-9 has a pending question");
		expect(await h.marked()).toHaveLength(before);
	});

	test("a failed resume after the answer is recorded says so", async () => {
		const { h } = await asked();
		Object.assign(h.fake.service, { resume: async () => ({ kind: "refused", reason: "not-resumable" }) });
		const out = await h.call("subagent_answer", { id: "agent-1", answer: "x" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).not.toContain("Nothing was launched or written");
		expect(textOf(out)).toContain("the answer is recorded");
		expect(textOf(out)).toContain("dispatch implementer U1 again");
	});

	test("refuses an id the executor no longer knows", async () => {
		const { h } = await asked();
		Object.assign(h.fake.service, { getRecord: () => undefined });
		const out = await h.call("subagent_answer", { id: "agent-1", answer: "x" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("no longer knows");
		expect(h.fake.resumed).toEqual([]);
	});
});
