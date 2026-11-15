import { afterEach, describe, expect, test } from "vitest";
import { runNextCommand } from "../../src/commands/next.ts";
import type { ChangeState, NextStep } from "../../src/engine/state-types.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { BUILD_LABELS, CHANGE_BRANCH, resumeBody } from "../hooks/helpers.ts";
import { cleanupDirs, textOf, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

describe("spec_status, spec_next and /livespec next", () => {
	test("Status mid-change", async () => {
		const h = await toolHarness({ branch: CHANGE_BRANCH });
		const n = await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		const out = await h.call("spec_status");
		const text = textOf(out);
		expect(out.isError).toBe(false);
		expect(text).toContain(`#${n}`);
		expect(text).toContain("Phase: build");
		expect(text).toContain("U1 — <untrusted>Request context</untrusted>: done");
		expect(text).toContain("U3 — <untrusted>Rate limit per IP</untrusted>: pending");
		const { state } = out.details as { state: ChangeState };
		expect(state.phase).toEqual({ kind: "ok", id: "build" });
		expect(state.change.units.map((u) => [u.id, u.done])).toEqual([
			["U1", true],
			["U3", false],
		]);
	});

	test("status rebuilds the snapshot before answering", async () => {
		const h = await toolHarness({ branch: CHANGE_BRANCH });
		const n = await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.session.refresh();
		await h.world.editBodyBehindBack(n, resumeBody(h.head).replace("- [ ] pending", "- [x] done"));
		expect(textOf(await h.call("spec_status"))).toContain("U3 — <untrusted>Rate limit per IP</untrusted>: done");
	});

	test("Next command matches tool", async () => {
		const h = await toolHarness({ branch: CHANGE_BRANCH });
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		const tool = await h.call("spec_next");
		const command = await runNextCommand(h.session);
		const { step } = tool.details as { step: NextStep };
		expect(step.next).toBe("Build U3 — Rate limit per IP.");
		expect(textOf(tool)).toContain("Next: <untrusted>Build U3 — Rate limit per IP.</untrusted>");
		expect(command).toBe(textOf(tool));
	});

	test("No change", async () => {
		const h = await toolHarness();
		const a = await h.world.seedIssue({ title: "rate-limit", labels: BUILD_LABELS });
		const out = await h.call("spec_next");
		const text = textOf(out);
		expect(out.isError).toBe(false);
		expect(out.details).toEqual({ step: null, open: [{ number: a, title: "rate-limit", phase: "build" }] });
		expect(text).toContain(`#${a} <untrusted>rate-limit</untrusted> (build)`);
		expect(text).toContain("change_start");
		expect(text).toContain("change_new");
		const status = await h.call("spec_status");
		expect(status.details).toEqual({ state: null, open: [{ number: a, title: "rate-limit", phase: "build" }] });
	});

	test("Tools refuse", async () => {
		const h = await toolHarness({
			branch: CHANGE_BRANCH,
			files: { ".pi/livespec/flow.yaml": "extends: agent-skills\nphases:\n  - id: build\n    gate: maybe\n" },
		});
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		expect(h.session.pack.ok).toBe(false);
		const out = await h.call("spec_next");
		expect(out.isError).toBe(true);
		expect(out.details).toEqual({ step: null });
		const text = textOf(out);
		expect(text).toMatch(/flow\.yaml:4:11 /);
		if (h.session.pack.ok) throw new Error("pack must be invalid");
		for (const e of h.session.pack.errors) expect(text).toContain(`${e.file}:${e.line}:${e.col}`);
		expect(textOf(await h.call("spec_status"))).toMatch(/flow\.yaml:4:11 /);
	});
});
