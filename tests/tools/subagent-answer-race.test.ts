// Two concurrent `subagent_answer` calls for one child: the claim is taken before the async packet read, so the child is resumed once.
import { afterEach, expect, test, vi } from "vitest";
import { setSession } from "../../src/hooks/session-store.ts";
import { clearInFlight } from "../../src/subagents/in-flight.ts";
import { done, unpublish } from "../subagents/fake-executor.ts";
import { cleanupDirs, textOf } from "./helpers.ts";
import { footerIds, subagentHarness } from "./subagent-helpers.ts";

const gate = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined, entered: () => undefined as void }));

vi.mock("../../src/subagents/packet-store.ts", async (orig) => {
	const real = await orig<typeof import("../../src/subagents/packet-store.ts")>();
	return {
		...real,
		readPacket: async (...args: Parameters<typeof real.readPacket>) => {
			const hold = gate.hold;
			gate.hold = undefined;
			if (hold !== undefined) {
				gate.entered();
				await hold;
			}
			return real.readPacket(...args);
		},
	};
});

afterEach(async () => {
	clearInFlight();
	unpublish();
	setSession(undefined);
	await cleanupDirs();
});

test("two concurrent answers to one child resume it once", async () => {
	const h = await subagentHarness({ executor: { records: [{ pendingQuestion: "Which?" }] } });
	await h.call("subagent_dispatch", { role: "implementer", unit: "U1" });
	h.fake.records.push({ structuredResult: done({ sources_used: [...footerIds(h.fake.spawned.at(-1)?.prompt ?? ""), "answer:agent-1:1"] }) });
	let open = (): void => undefined;
	const inRead = new Promise<void>((r) => { gate.entered = r as never; });
	gate.hold = new Promise<void>((r) => { open = r; });
	const b = h.call("subagent_answer", { id: "agent-1", answer: "B" });
	await inRead;
	const a = await h.call("subagent_answer", { id: "agent-1", answer: "A" });
	open();
	const outs = [a, await b];
	expect(outs.filter((o) => o.isError), outs.map(textOf).join("\n")).toHaveLength(1);
	expect(h.fake.resumed).toHaveLength(1);
});
