// The dispatch tool never writes to the forge before an aborted child has settled (or the bounded wait expires).
import { afterEach, expect, test } from "vitest";
import { parseMarked } from "../../src/forge/markers.ts";
import { type DispatchDeps, type DispatchRequest, runDispatch } from "../../src/subagents/dispatch.ts";
import type { RecordLike } from "../../src/subagents/executor.ts";
import type { Packet } from "../../src/subagents/source-types.ts";
import { fakeExecutor, unpublish } from "./fake-executor.ts";

afterEach(unpublish);

const packet: Packet = { text: "PACKET", hash: "a".repeat(64), sources: [], skillPaths: [], cwd: "/w/c", seen: [] };
const request: DispatchRequest = { role: "implementer", unit: "U1", packet, change: "c", difficulty: "low", failedAttempts: 0, exclusions: [], attempt: 1, round: 1, needsContext: 0 };

/** A child whose `wait` settles `settleMs` after `abort` (never, when `settleMs` is undefined). */
function abortableChild(settleMs: number | undefined, abortSettleMs?: number, signal?: AbortSignal) {
	const fake = fakeExecutor({ facts: () => ({ inheritSkills: true }) });
	let settled = false;
	let release: (r: RecordLike) => void = () => undefined;
	const gate = new Promise<RecordLike>((r) => { release = r; });
	fake.service.wait = async () => gate;
	const abort = fake.service.abort;
	fake.service.abort = (id: string) => {
		const result = abort(id);
		if (settleMs !== undefined) setTimeout(() => { settled = true; release({ id, status: "stopped" }); }, settleMs);
		return result;
	};
	const posted: { settledAtForgeWrite: boolean; evidence: string }[] = [];
	const d: DispatchDeps = {
		service: fake.service, events: fake.events,
		record: async (input) => {
			posted.push({ settledAtForgeWrite: settled, evidence: String((input.data as Record<string, unknown>).evidence) });
		},
		headOf: async () => "h".repeat(40),
		reachable: async (_cwd, commits) => commits,
		onOverride: () => undefined,
		...(abortSettleMs === undefined ? {} : { abortSettleMs }),
		...(signal === undefined ? {} : { signal }),
	};
	return { d, posted };
}

test("launch-mismatch is posted only after the aborted child settled", async () => {
	const { d, posted } = abortableChild(40);
	await runDispatch(d, request);
	expect(posted).toHaveLength(1);
	expect(posted[0]?.settledAtForgeWrite).toBe(true);
});

test("when the child never settles, nothing is posted and the outcome says so", async () => {
	const { d, posted } = abortableChild(undefined, 30);
	const started = Date.now();
	const out = await runDispatch(d, request);
	expect(Date.now() - started).toBeGreaterThanOrEqual(25);
	expect(posted).toHaveLength(0);
	expect(out.kind).toBe("inline");
	const reason = (out as { reason: string }).reason;
	expect(reason).toContain("not recorded");
	expect(reason).toContain("agent-1");
	expect(reason).toContain("did not settle within");
});

test("a cancel during the settle wait records nothing and returns cancelled", async () => {
	const controller = new AbortController();
	const { d, posted } = abortableChild(40, undefined, controller.signal);
	setTimeout(() => controller.abort(), 10);
	const out = await runDispatch(d, request);
	expect(posted).toHaveLength(0);
	expect(out.kind).toBe("cancelled");
});
