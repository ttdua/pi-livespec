// Shared setup for the subagent tool tests: a unit harness with a content tree, pi's event bus and the four subagent tools.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarkedComment } from "../../src/forge/markers.ts";
import { registerSubagentAnswer } from "../../src/tools/subagent-answer.ts";
import { registerSubagentDispatch } from "../../src/tools/subagent-dispatch.ts";
import { registerSubagentPacket } from "../../src/tools/subagent-packet.ts";
import { registerSubagentRecord } from "../../src/tools/subagent-record.ts";
import { DEFAULT_SKILLS, makeTree } from "../subagents/packet-world.ts";
import { fakeExecutor, publish } from "../subagents/fake-executor.ts";
import { type UnitSpec, unitHarness } from "./unit-helpers.ts";

export const U1: UnitSpec = { id: "U1", verify: "sh check.sh", difficulty: "medium" };
export const U2: UnitSpec = { id: "U2", verify: "sh check.sh", depends: ["U1"] };
const SPEC = readFileSync(new URL("../fixtures/rate-limit.spec.md", import.meta.url), "utf8");
const SCRIPTS = { "check.sh": "test -f src/u1.ts\n", "specs/rate-limit/spec.md": SPEC };

export type SubagentHarness = Awaited<ReturnType<typeof subagentHarness>>;

/** `executor` publishes a fake service; without it no executor is present. `home` holds pi settings for the isolation list. */
export async function subagentHarness(o: { units?: UnitSpec[]; executor?: Parameters<typeof fakeExecutor>[0]; config?: string } = {}) {
	const h = await unitHarness({ units: o.units ?? [U1, U2], scripts: SCRIPTS, ...(o.config === undefined ? {} : { config: o.config }) });
	h.session.activeTree = makeTree([...DEFAULT_SKILLS]);
	const fake = fakeExecutor(o.executor);
	if (o.executor !== undefined) publish(fake.service);
	Object.assign(h.pi.api, { events: fake.events });
	const home = mkdtempSync(join(tmpdir(), "ls-sub-home-"));
	const deps = { home: () => home };
	registerSubagentDispatch(h.pi.api as never, deps);
	registerSubagentAnswer(h.pi.api as never, deps);
	registerSubagentPacket(h.pi.api as never);
	registerSubagentRecord(h.pi.api as never, deps);
	await h.session.refresh();
	const latest = async (kind: string): Promise<MarkedComment | undefined> => (await h.ofKind(kind)).at(-1);
	return { ...h, fake, home, latest };
}

/** Source ids of a packet's footer: one `<id> <version>` line per source after `Packet hash:`. */
export const footerIds = (text: string): string[] => text.split("Packet hash:")[1]?.split("\n").slice(1).filter((l) => l.includes(" ")).map((l) => l.split(" ")[0] as string) ?? [];
