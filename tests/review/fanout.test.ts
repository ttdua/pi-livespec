// Tests of the review fan-out: concurrent launches and cancellation.
import { afterEach, describe, expect, test } from "vitest";
import { parseMarked } from "../../src/forge/markers.ts";
import { type DispatchDeps, type DispatchRequest, runDispatch } from "../../src/subagents/dispatch.ts";
import type { Packet } from "../../src/subagents/source-types.ts";
import { fanOut } from "../../src/review/fanout.ts";
import { done, fakeExecutor, unpublish } from "../subagents/fake-executor.ts";

afterEach(unpublish);

const packet: Packet = { text: "PACKET", hash: "a".repeat(64), sources: [], skillPaths: [], cwd: "/w/c", seen: [] };
const request = (subject: "change" | `persona:${string}`): DispatchRequest => ({
	role: "reviewer", subject, packet, change: "c", difficulty: "low", failedAttempts: 0, exclusions: [], attempt: 1, round: 1, needsContext: 0,
});

function deps(fake: ReturnType<typeof fakeExecutor>, signal?: AbortSignal) {
	const posted: string[] = [];
	const d: DispatchDeps = {
		service: fake.service, events: fake.events, onOverride: () => undefined,
		record: async (input) => {
			posted.push(input.id);
		},
		headOf: async () => "h".repeat(40),
		reachable: async (_cwd, commits) => commits,
		...(signal === undefined ? {} : { signal, abortSettleMs: 50 }),
	};
	return { d, posted };
}

describe("fanOut", () => {
	test("Parallel reviewers", async () => {
		const reviewer = { structuredResult: JSON.parse(JSON.stringify(done({ findings: [], commits: undefined }))) };
		const fake = fakeExecutor({ records: [reviewer, reviewer] });
		const { d, posted } = deps(fake);
		const subjects = ["change", "persona:security-auditor"] as const;
		const settled = await fanOut(subjects.map((s) => () => runDispatch(d, request(s))));
		expect(fake.log.slice(0, 2)).toEqual(["spawn:agent-1", "spawn:agent-2"]);
		expect(settled.map((s) => s.status === "fulfilled" && s.value.kind)).toEqual(["result", "result"]);
		expect(posted).toEqual(["finding-summary.change.change.1", "finding-summary.change.persona-security-auditor.1"]);
	});

	test("cancelled mid fan-out aborts every child and records nothing", async () => {
		const fake = fakeExecutor({ holdUntilAborted: true });
		const cancel = new AbortController();
		const { d, posted } = deps(fake, cancel.signal);
		const pending = fanOut([() => runDispatch(d, request("change")), () => runDispatch(d, request("persona:x"))], cancel.signal);
		setTimeout(() => cancel.abort(), 10);
		const settled = await pending;
		expect([...fake.aborted].sort()).toEqual(["agent-1", "agent-2"]);
		expect(settled.map((s) => s.status === "fulfilled" && s.value.kind)).toEqual(["cancelled", "cancelled"]);
		expect(posted).toEqual([]);
	});

	test("an already cancelled call launches nothing", async () => {
		const fake = fakeExecutor({});
		const cancel = new AbortController();
		cancel.abort();
		const { d } = deps(fake, cancel.signal);
		const settled = await fanOut([() => runDispatch(d, request("change"))], cancel.signal);
		expect(fake.spawned).toEqual([]);
		expect(settled[0]).toMatchObject({ status: "fulfilled", value: { kind: "cancelled" } });
	});
});
