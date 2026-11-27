// Tests of `subagent_answer`: a child's question survives a reload through its record, and the answer resumes the child.
import { afterEach, describe, expect, test } from "vitest";
import { setSession } from "../../src/hooks/session-store.ts";
import { claim, clearInFlight, targetKey } from "../../src/subagents/in-flight.ts";
import { done, unpublish } from "../subagents/fake-executor.ts";
import { cleanupDirs, textOf } from "./helpers.ts";
import { footerIds, subagentHarness } from "./subagent-helpers.ts";
import { cardState } from "./unit-helpers.ts";

afterEach(async () => {
	clearInFlight();
	unpublish();
	setSession(undefined);
	await cleanupDirs();
});

type H = Awaited<ReturnType<typeof subagentHarness>>;

/** Required source ids of the latest packet a child got. */
const required = (h: H): string[] => footerIds(h.fake.spawned.at(-1)?.prompt ?? "");

async function asked(question = "Which config file?") {
	const h = await subagentHarness({ executor: { records: [{ pendingQuestion: question }] } });
	const out = await h.call("subagent_dispatch", { role: "implementer", unit: "U1" });
	return { h, out };
}

describe("questions from a child", () => {
	test("ask and answer", async () => {
		const { h, out } = await asked();
		expect(textOf(out)).toContain("Child agent-1 asks: <untrusted>Which config file?</untrusted>");
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

	test("the child's own answer does not make its packet stale at unit_finish", async () => {
		const h = await subagentHarness({ executor: { records: [{ pendingQuestion: "Which config file?" }] } });
		expect((await h.start("U1")).isError).toBeFalsy();
		await h.call("subagent_dispatch", { role: "implementer", unit: "U1" });
		await h.commit({ "src/u1.ts": "x\n" });
		h.fake.records.push({ structuredResult: done({ sources_used: [...required(h), "answer:agent-1:1"] }) });
		const answered = await h.call("subagent_answer", { id: "agent-1", answer: "the project one" });
		expect(answered.isError, textOf(answered)).toBeFalsy();
		const spawn = h.fake.service.spawn;
		Object.assign(h.fake.service, {
			spawn: (type: string, prompt: string, o: never) => {
				h.fake.records.push({ structuredResult: { status: "DONE", notes: "clean", discoveries: [], sources_used: footerIds(prompt), findings: [] } });
				return spawn(type, prompt, o);
			},
		});
		const review = await h.call("subagent_dispatch", { role: "reviewer", unit: "U1", subject: "unit" });
		expect(review.isError, textOf(review)).toBeFalsy();
		const finished = await h.finish("U1");
		expect(finished.isError, textOf(finished)).toBeFalsy();
		expect((await h.units())[0]?.done).toBe(true);
	});

	test("a change reviewer's answer is optional in the next change packet", async () => {
		const h = await subagentHarness({ executor: { records: [{ pendingQuestion: "Which config file?" }] } });
		const out = await h.call("subagent_dispatch", { role: "reviewer", subject: "change" });
		expect(textOf(out)).toContain("Child agent-1 asks");
		const requiredOnly = required(h).filter((id) => !id.startsWith("records:"));
		h.fake.records.push({ structuredResult: JSON.parse(JSON.stringify({ ...done({ sources_used: requiredOnly }), commits: undefined, findings: [] })) });
		const answered = await h.call("subagent_answer", { id: "agent-1", answer: "the project one" });
		expect(answered.isError, textOf(answered)).toBeFalsy();
		expect(h.fake.resumed).toEqual([{ id: "agent-1", prompt: "the project one" }]);
		expect((await h.latest("finding-summary"))?.data).toMatchObject({ status: "DONE", completed: true });
		const packet = textOf(await h.call("subagent_packet", { role: "reviewer", subject: "change" }));
		const ids = footerIds(packet);
		expect(ids).toContain("records:dispatch-answers");
		expect(ids).not.toContain("answer:agent-1:1");
		const section = packet.split("### records:dispatch-answers")[1]?.split("\n### ")[0] ?? "";
		expect(section).toContain("optional: list in sources_used only if you used it");
		expect(section).toContain("answer:agent-1:1");
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

describe("missing result after an answer", () => {
	test("Missing result after an answer", async () => {
		const h = await subagentHarness({ executor: { records: [{ pendingQuestion: "Which?" }, { result: "I will stop." } as never] } });
		await h.call("subagent_dispatch", { role: "implementer", unit: "U1" });
		h.fake.records.push({ structuredResult: done({ sources_used: [...required(h), "answer:agent-1:1"] }) });
		const out = await h.call("subagent_answer", { id: "agent-1", answer: "x" });
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(h.fake.spawned).toHaveLength(1);
		expect(h.fake.resumed.map((r) => r.id)).toEqual(["agent-1", "agent-1"]);
		expect((await h.latest("dispatch"))?.data).toMatchObject({ agentId: "agent-1", status: "DONE" });
	});

	test("One fallback respawn per dispatch", async () => {
		const h = await subagentHarness({ executor: { resumes: ["ok", "refuse"], records: [{ pendingQuestion: "Which?" }, { result: "text" } as never] } });
		await h.seed("dispatch", "dispatch.U1.implementer.retry.agent-1", { status: "RETRY", role: "implementer", unit: "U1", agentId: "agent-0", newAgentId: "agent-1", attempt: 1, reason: "r" });
		await h.call("subagent_dispatch", { role: "implementer", unit: "U1" });
		const out = await h.call("subagent_answer", { id: "agent-1", answer: "x" });
		expect(h.fake.spawned).toHaveLength(1);
		expect(textOf(out)).toContain("BLOCKED");
	});
});

describe("one live dispatch per target", () => {
	test("answer refuses while the same target is in flight", async () => {
		const { h } = await asked();
		claim(targetKey(h.n, { role: "implementer", unit: "U1" }));
		const out = await h.call("subagent_answer", { id: "agent-1", answer: "this one" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("implementer U1");
		expect(textOf(out)).toContain("already running");
		expect(h.fake.resumed).toEqual([]);
	});
});

describe("verifier answer", () => {
	const AGG = {
		role: "reviewer", subject: "change", round: 1, status: "DONE", advisory: false, head: "h1", packet: "p", sources_used: [], required: [], completed: true,
		agentSource: "s", requested: { thinking: "low" }, effective: {}, aggregate: true, reviews: ["c0"],
		findings: [{ severity: "WARNING", kind: "defect", location: "src/free.ts:4", evidence: "e", fix: "f", scope: "in-change", from: ["c0"], needsDecision: false, route: "in-change", verify: "required" }],
	};

	test("resumes after the stored packet is gone, rebuilding with the finding", async () => {
		const h = await subagentHarness({ executor: { records: [{ pendingQuestion: "Which?" }] } });
		await h.seed("finding-summary", "finding-summary.change.review.1", AGG);
		const key = `${(await h.latest("finding-summary"))?.ref}:0`;
		const out = await h.call("subagent_dispatch", { role: "verifier", finding: key });
		expect(textOf(out)).toContain("agent-1 asks");
		const { rmSync } = await import("node:fs");
		const { spillDirectory } = await import("../../src/subagents/spill.ts");
		const stored = (await h.latest("dispatch"))?.data as { launch: { packet: string } };
		rmSync(`${await spillDirectory(h.root, "per-ip-cap", stored.launch.packet)}.packet.json`, { force: true });
		h.fake.records.push({ structuredResult: done({ findings: [], commits: undefined, verdict: "confirmed", sources_used: [...required(h), "answer:agent-1:1"] }) });
		const answered = await h.call("subagent_answer", { id: "agent-1", answer: "x" });
		expect(textOf(answered)).not.toContain("a verifier packet needs the finding");
		expect(answered.isError, textOf(answered)).toBeFalsy();
		expect(h.fake.resumed[0]).toEqual({ id: "agent-1", prompt: "x" });
	});
});

describe("fallback contract end to end", () => {
	test("a fallback asks, is answered, ends without a result and is not replaced", async () => {
		const h = await subagentHarness({ executor: { resumes: ["refuse", "ok", "refuse"], records: [{ result: "text" } as never, { pendingQuestion: "Which?" }, { result: "text" } as never] } });
		const asked = await h.call("subagent_dispatch", { role: "implementer", unit: "U1" });
		expect(textOf(asked)).toContain("agent-1");
		expect(textOf(asked)).toContain("agent-2");
		expect(textOf(asked)).toContain("Which?");
		const retry = (await h.ofKind("dispatch")).map((m) => m.data as Record<string, unknown>).find((d) => d.status === "RETRY");
		expect(retry).toMatchObject({ agentId: "agent-1", newAgentId: "agent-2" });
		expect(h.fake.spawned[0]?.options.metadata.packet).toBe(h.fake.spawned[1]?.options.metadata.packet);
		const out = await h.call("subagent_answer", { id: "agent-2", answer: "x" });
		expect(textOf(out)).toContain("BLOCKED");
		expect(h.fake.spawned).toHaveLength(2);
		expect((await h.latest("dispatch"))?.data).toMatchObject({ status: "BLOCKED", agentId: "agent-2" });
	});
});
