// `spec_gate define|review` asks the `behavior-change` question (durable-doc-checks "Behavior change question at
// the gate", phase-gates "Gate tool"): only when no other refusal applies, one capability at a time, and the
// re-run check refuses a `changed` answer in the same call.

import { BRIEFING } from "../helpers/briefing.ts";
import { pickById } from "../helpers/menu.ts";
import { registerSpecGate } from "../../src/tools/spec-gate.ts";
import { FakePi } from "../hooks/fake-pi.ts";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type DecisionRecord, decisionComment } from "../../src/decide/records.ts";
import { behaviorDigest } from "../../src/docs/behavior-change.ts";
import { registerCheck } from "../../src/engine/registry.ts";
import { filterMarked, type MarkedComment } from "../../src/forge/markers.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { resetGatesForTests } from "../../src/engine/gates.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import type { FakeUI, SelectFn } from "../hooks/fake-pi.ts";
import { allDone, CHANGE_BRANCH, resumeBody } from "../hooks/helpers.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "./helpers.ts";

const RATE_SPEC = readFileSync(new URL("../fixtures/rate-limit.spec.md", import.meta.url), "utf8");
const AUTH_SPEC = RATE_SPEC.replace(/^paths: .*$/m, 'paths: ["src/auth/**"]').replace("# rate-limit", "# auth");
const FLOW = "extends: agent-skills\nphases:\n  - id: define\n    checks: [spec-format, capabilities-match-diff, behavior-change]\n  - id: review\n    checks: [behavior-change]\n";
const FORGE_CHAIN = "integrationBranch: main\ninteraction: { adapter: [forge] }\n";
const CAP = "src/limits/cap.ts";
const WINDOW = "src/limits/window.ts";
const FORGE_FILE = "src/forge/read.ts";
const FORGE_SPEC = RATE_SPEC.replace(/^paths: .*$/m, 'paths: ["src/forge/**"]').replace("# rate-limit", "# forge-read");
const RATIONALE = "cap is an internal constant";
const unchanged = (capability: string, rationale = RATIONALE) => ({ capability, outcome: "unchanged", rationale });

type Gate = ToolHarness & { n: number };
type Opts = { config?: string; edit?: (b: string) => string; code?: string[]; authSpec?: string; flow?: string; baseFiles?: Record<string, string>; renames?: [string, string][] };
const FLOW_WITHOUT_CHECK = "extends: agent-skills\nphases:\n  - id: define\n    checks: [spec-format, capabilities-match-diff]\n";

beforeEach(() => {
	// The real check needs a worktree run per unit; the define gate here does not depend on it.
	registerCheck("verify-red-on-base", async () => [], { waivable: true, at: "gate", key: () => "stub" });
});

afterEach(async () => {
	setSession(undefined);
	resetGatesForTests();
	await cleanupDirs();
});

/** A scripted human: every dialog approves. */
function human(): FakeUI {
	const select: SelectFn = async (title, options) => (title === "Add notes?" ? "No notes" : pickById(options, "approve"));
	return { hasUI: true, select };
}

/**
 * A define change: `rate-limit` and `auth` specs at Base; the change edits `specs/auth/spec.md` (declared modified)
 * and code under rate-limit's `paths`, so `rate-limit` is the one behavior item.
 */
async function change(phase: string, o: Opts = {}): Promise<Gate> {
	const h = await toolHarness({
		branch: CHANGE_BRANCH,
		config: o.config ?? "integrationBranch: main\n",
		ui: human(),
		files: { ".pi/livespec/flow.yaml": o.flow ?? FLOW, "specs/rate-limit/spec.md": RATE_SPEC, "specs/auth/spec.md": AUTH_SPEC, "specs/forge-read/spec.md": FORGE_SPEC, ...o.baseFiles },
	});
	const base = h.git("rev-parse", "HEAD");
	await writeIn(h.root, "specs/auth/spec.md", o.authSpec ?? `${AUTH_SPEC}\nMore context.\n`);
	for (const file of o.code ?? [CAP]) await writeIn(h.root, file, "export const cap = 100;\n");
	for (const [from, to] of o.renames ?? []) h.git("mv", from, to);
	commitAll(h.root, "change");
	const body = (o.edit ?? ((b: string) => b))(resumeBody(base).replace("modified [rate-limit]", "modified [auth]"));
	const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", `livespec:phase/${phase}`] });
	await h.session.refresh();
	return { ...h, n };
}

async function marked(h: Gate): Promise<MarkedComment[]> {
	return filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
}
const ofKind = async (h: Gate, kind: string) => (await marked(h)).filter((m) => m.kind === kind);
const subjectOf = (m: MarkedComment): string => (m.data as { subject?: string; request?: { subject?: string } }).subject ?? (m.data as { request?: { subject?: string } }).request?.subject ?? "";
const behaviorDecisions = async (h: Gate, capability = "rate-limit") => (await ofKind(h, "decision")).filter((m) => m.id === `behavior-change.${capability}`);
const behaviorRequests = async (h: Gate) => (await ofKind(h, "request")).map(subjectOf).filter((s) => s.startsWith("decide:behavior-change"));
const gate = (h: Gate, behavior: unknown, target = "define") => h.call("spec_gate", { target, briefing: BRIEFING, ...(behavior === undefined ? {} : { behavior }) });

describe("spec_gate behavior conclusions", () => {
	test("Two capabilities, no dialog", async () => {
		const h = await change("define", { code: [CAP, FORGE_FILE], edit: allDone });
		const out = await gate(h, [unchanged("rate-limit"), unchanged("forge-read", "read path only")]);
		expect(out.isError).toBe(false);
		const decisions = (await ofKind(h, "decision")).filter((m) => (m.data as { source?: string }).source === "agent");
		expect(decisions).toHaveLength(2);
		expect(await behaviorRequests(h)).toEqual([]);
		expect(h.ctx.ui.select.mock.calls.map((c) => c[0]).filter((t) => t !== "Add notes?")).toHaveLength(1);
	});

	test("Missing conclusion", async () => {
		const h = await change("define", { code: [CAP, FORGE_FILE] });
		const before = (await marked(h)).length;
		const out = await gate(h, [unchanged("rate-limit")]);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("forge-read");
		expect((await marked(h)).length).toBe(before);
	});

	test("Unknown capability listed", async () => {
		const h = await change("define");
		const before = (await marked(h)).length;
		const out = await gate(h, [unchanged("rate-limit"), unchanged("cache")]);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("cache");
		expect((await marked(h)).length).toBe(before);
	});

	describe("Other refusal writes nothing", () => {
		const refusedWithNothingWritten = async (h: Gate, reason: string): Promise<void> => {
			const before = (await marked(h)).length;
			const out = await gate(h, [unchanged("rate-limit")]);
			expect(out.isError).toBe(true);
			expect(textOf(out)).toContain(reason);
			expect((await marked(h)).length).toBe(before);
		};

		test("dirty tree", async () => {
			const h = await change("define");
			await writeIn(h.root, "scratch.txt", "x");
			await refusedWithNothingWritten(h, "dirty");
		});

		test("blocking question", async () => {
			const h = await change("define", { edit: (b) => b.replace("- [x] Q1 (blocking)", "- [ ] Q1 (blocking)") });
			await refusedWithNothingWritten(h, "Q1");
		});

		test("spec-format error", async () => {
			const h = await change("define", { authSpec: "# auth\n\n## Purpose\nNothing.\n\n## Requirements\n" });
			await refusedWithNothingWritten(h, "spec-format");
		});
	});

	test("Changed conclusion blocks the same call", async () => {
		const h = await change("define");
		const out = await gate(h, [{ capability: "rate-limit", outcome: "changed", rationale: "cap now rejects" }]);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("specs/rate-limit/spec.md");
		expect((await ofKind(h, "gate"))).toEqual([]);
		expect((await ofKind(h, "request")).filter((m) => subjectOf(m) === "gate:define")).toEqual([]);
	});

	test("Behavior answer before a refusal", async () => {
		const h = await change("define");
		const out = await gate(h, [{ capability: "rate-limit", outcome: "changed", rationale: "cap now rejects" }]);
		expect(textOf(out)).toContain("behavior-change");
		expect(await behaviorDecisions(h)).toHaveLength(1);
		expect(await behaviorRequests(h)).toEqual([]);
	});

	test("Agent conclusion recorded", async () => {
		const h = await change("define");
		await gate(h, [unchanged("rate-limit")]);
		const [decision] = await behaviorDecisions(h);
		expect(decision?.data).toMatchObject({ point: "behavior-change", subject: "rate-limit", source: "agent", outcome: "unchanged", reason: RATIONALE, files: [CAP], digest: behaviorDigest([CAP]) });
	});

	test("Same conclusion not re-posted", async () => {
		// `changed` keeps the gate refusing, so the phase stays define between calls.
		const changed = (rationale: string) => [{ capability: "rate-limit", outcome: "changed", rationale }];
		const h = await change("define");
		await gate(h, changed("cap rejects"));
		await gate(h, changed("cap rejects"));
		expect(await behaviorDecisions(h)).toHaveLength(1);
		await gate(h, changed("another reason"));
		expect(await behaviorDecisions(h)).toHaveLength(2);
	});

	test("New file is concluded again", async () => {
		const h = await change("define", { code: [CAP, WINDOW] });
		await h.world.postComment(h.n, BOT_LOGIN, decisionComment({ point: "behavior-change", subject: "rate-limit", digest: behaviorDigest([CAP]), source: "agent", outcome: "unchanged", facts: { capability: "rate-limit", files: [CAP] }, files: [CAP], reason: RATIONALE }));
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		const out = await gate(h, [unchanged("rate-limit")]);
		expect(out.isError).toBe(false);
		expect((await behaviorDecisions(h))[1]?.data).toMatchObject({ files: [CAP, WINDOW] });
	});

	test("a non-ASCII name with a space is concluded", async () => {
		const file = "src/limits/naïve cap.ts";
		const h = await change("define", { code: [file] });
		const out = await gate(h, [unchanged("rate-limit")]);
		expect(out.isError).toBe(false);
		expect((await behaviorDecisions(h))[0]?.data).toMatchObject({ source: "agent", files: [file] });
	});

	test("a rename out of the capability's paths is concluded", async () => {
		const moved = "src/cap.ts";
		const h = await change("define", { code: [], baseFiles: { [CAP]: "export const cap = 100;\n" }, renames: [[CAP, moved]] });
		const out = await gate(h, [unchanged("rate-limit")]);
		expect(out.isError).toBe(false);
		expect((await behaviorDecisions(h))[0]?.data).toMatchObject({ outcome: "unchanged", files: [CAP] });
	});

	test("Flow without the check", async () => {
		const h = await change("define", { flow: FLOW_WITHOUT_CHECK });
		const out = await gate(h, undefined);
		expect(out.isError).toBe(false);
		expect(await behaviorDecisions(h)).toEqual([]);
		expect(await behaviorRequests(h)).toEqual([]);
		expect((await ofKind(h, "gate"))[0]?.data).toMatchObject({ phase: "define", outcome: "approved" });
	});

	test("a legacy open request is not asked again", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		const out = await gate(h, [{ capability: "rate-limit", outcome: "changed", rationale: "x" }]);
		expect(out.isError).toBe(true);
		expect(await behaviorRequests(h)).toEqual([]);
	});

	test("read-only forge refuses before writing", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		await h.world.makeUnreachable();
		const out = await gate(h, [unchanged("rate-limit")]);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("read-only");
		await h.world.restore();
		expect(await marked(h)).toEqual([]);
	});

	test("execute passes behavior to runSpecGate", async () => {
		const h = await change("define");
		const pi = new FakePi();
		registerSpecGate(pi.api as never);
		const tool = pi.tools.get("spec_gate");
		await tool?.execute("id", { target: "define", briefing: BRIEFING, behavior: [unchanged("rate-limit")] }, undefined, undefined, h.ctx);
		expect((await behaviorDecisions(h))[0]?.data).toMatchObject({ source: "agent" });
	});

	describe("Behavior parameter shape", () => {
		test("Rationale too long", async () => {
			const h = await change("define");
			const before = (await marked(h)).length;
			const out = await gate(h, [unchanged("rate-limit", "é".repeat(301))]);
			expect(out.isError).toBe(true);
			expect(textOf(out)).toContain("behavior");
			expect(textOf(out)).toContain("300");
			expect((await marked(h)).length).toBe(before);
			expect((await gate(h, [unchanged("rate-limit", "é".repeat(300))])).isError).toBe(false);
		});

		test("empty behavior with no items passes", async () => {
			const h = await change("define", { code: [] });
			expect((await gate(h, [])).isError).toBe(false);
		});

		test("non-empty behavior with no items is refused", async () => {
			const h = await change("define", { code: [] });
			const out = await gate(h, [unchanged("rate-limit")]);
			expect(out.isError).toBe(true);
			expect(textOf(out)).toContain("rate-limit");
		});

		test("a rationale with a comment opener is neutralised", async () => {
			const h = await change("define");
			await gate(h, [unchanged("rate-limit", "see <!-- x -->")]);
			const reason = (await behaviorDecisions(h))[0]?.data as { reason: string };
			expect(reason.reason).not.toContain("<!--");
			await gate(h, [unchanged("rate-limit", "see <!-- x -->")]);
			expect(await behaviorDecisions(h)).toHaveLength(1);
		});
	});
});
