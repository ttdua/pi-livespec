// End-to-end build flow: the real unit tools, the guard and the settle hook of
// the loaded extension, over a memory forge and a temporary repository.

import { afterEach, expect, test } from "vitest";
import extension from "../../src/extension.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { FakePi, fakeCtx } from "../hooks/fake-pi.ts";
import { cleanupDirs, originRefs, textOf } from "../tools/helpers.ts";
import { unitHarness } from "../tools/unit-helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

test("build flow: start red, finish green, receipt and tick, guarded bash, quiet settle", async () => {
	const h = await unitHarness({ units: [{ id: "U1", verify: "sh check.sh" }], scripts: { "check.sh": "test -f src/u1.ts\n" } });
	const pi = new FakePi();
	extension(pi.api as never);
	const ctx = fakeCtx(h.root);
	const bash = (command: string) => pi.fire("tool_call", { type: "tool_call", toolName: "bash", toolCallId: command, input: { command } }, ctx) as Promise<{ block?: boolean; reason?: string } | undefined>;

	const started = await h.start("U1");
	expect(started.isError, textOf(started)).toBeFalsy();
	expect((await h.ofKind("unit-start"))[0]?.data).toMatchObject({ unit: "U1", pre: { verdict: "red" } });

	const post = await h.commit({ "src/u1.ts": "export const limit = 1;\n" }, "fix U1");
	const finished = await h.finish("U1");
	expect(finished.isError, textOf(finished)).toBeFalsy();

	expect((await h.ofKind("receipt"))[0]?.data).toMatchObject({ unit: "U1", post: { sha: post, exit: 0 } });
	expect((await h.units())[0]?.done).toBe(true);

	const body = await h.world.bodyOf(h.n);
	const refs = originRefs(h.origin, { ignoreLedger: true });
	const edit = await bash(`gh issue edit ${h.n} --body x`);
	expect(edit?.block).toBe(true);
	expect(edit?.reason).toMatch(/^livespec guard:/);
	expect((await bash("git push"))?.block).toBe(true);
	expect(await h.world.bodyOf(h.n)).toBe(body);
	expect(originRefs(h.origin, { ignoreLedger: true })).toBe(refs);

	const settle = await pi.fire("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false, context: {}, outcome: "completed" }, ctx);
	expect(settle).toBeUndefined();
	expect(await h.ofKind("incomplete")).toEqual([]);
});
