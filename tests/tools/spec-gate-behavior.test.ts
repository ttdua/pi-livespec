// `spec_gate define|review` asks the `behavior-change` question (durable-doc-checks "Behavior change question at
// the gate", phase-gates "Gate tool"): only when no other refusal applies, one capability at a time, and the
// re-run check refuses a `changed` answer in the same call.

import { readOwnRecords } from "../../src/ledger/records.ts";
import { appendSeed } from "../helpers/ledger.ts";
import { BRIEFING } from "../helpers/briefing.ts";
import { pickById } from "../helpers/menu.ts";
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
const BEHAVIOR_TITLE = "Did the behavior of rate-limit change?";

type Gate = ToolHarness & { n: number };
type Opts = { answer?: string; config?: string; edit?: (b: string) => string; code?: string[]; authSpec?: string; flow?: string; baseFiles?: Record<string, string>; renames?: [string, string][] };
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

/** A scripted human: the behavior question picks `answer`, the gate dialog approves. */
function human(answer: string | undefined): FakeUI {
	const select: SelectFn = async (title, options) => {
		if (title === "Add notes?") return "No notes";
		const pick = title.startsWith(BEHAVIOR_TITLE) ? answer : "approve";
		if (pick === undefined) return undefined;
		return pickById(options, pick);
	};
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
		ui: human(o.answer),
		files: { ".pi/livespec/flow.yaml": o.flow ?? FLOW, "specs/rate-limit/spec.md": RATE_SPEC, "specs/auth/spec.md": AUTH_SPEC, ...o.baseFiles },
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
	return (await readOwnRecords(h.world.forge, h.session.ledger, h.n, { login: BOT_LOGIN })).records;
}
const ofKind = async (h: Gate, kind: string) => (await marked(h)).filter((m) => m.kind === kind);
const subjectOf = (m: MarkedComment): string => (m.data as { subject?: string; request?: { subject?: string } }).subject ?? (m.data as { request?: { subject?: string } }).request?.subject ?? "";
const behaviorDecisions = async (h: Gate) => (await ofKind(h, "decision")).filter((m) => m.id === "behavior-change.rate-limit");
const behaviorTitles = (h: Gate): string[] => h.ctx.ui.select.mock.calls.map((c) => c[0]).filter((t) => t.startsWith(BEHAVIOR_TITLE));

async function seedRecord(h: Gate, files: string[], outcome: string): Promise<void> {
	const item = { capability: "rate-limit", files };
	const r: DecisionRecord = { point: "behavior-change", subject: "rate-limit", digest: behaviorDigest(files), source: "human", outcome, facts: item, files, reason: "chosen by alice" };
	await appendSeed(h, decisionComment(r));
}

describe("spec_gate behavior-change question", () => {
	test("Asked once at define", async () => {
		// Every unit done, so the change can be in review after define.
		const h = await change("define", { answer: "unchanged", edit: allDone });
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(out.isError).toBe(false);
		const [decision] = await behaviorDecisions(h);
		expect(decision?.data).toMatchObject({ point: "behavior-change", subject: "rate-limit", source: "human", outcome: "unchanged", files: [CAP], digest: behaviorDigest([CAP]) });
		const gate = (await ofKind(h, "gate"))[0];
		expect(gate?.data).toMatchObject({ phase: "define", outcome: "approved" });
		// The behavior question came before the gate dialog.
		const titles = h.ctx.ui.select.mock.calls.map((c) => c[0]);
		expect(titles[0]).toContain(BEHAVIOR_TITLE);
		expect(behaviorTitles(h)).toHaveLength(1);

		// A later `spec_gate review` with the same item asks nothing.
		await h.forge.removeLabels(h.n, ["livespec:phase/plan"]);
		await h.forge.addLabels(h.n, ["livespec:phase/review"]);
		await h.session.refresh();
		const before = (await ofKind(h, "request")).length;
		const review = await h.call("spec_gate", { target: "review", briefing: BRIEFING });
		expect(review.isError).toBe(false);
		expect(behaviorTitles(h)).toHaveLength(1);
		expect((await ofKind(h, "request")).length).toBe(before);
		expect(await behaviorDecisions(h)).toHaveLength(1);
	});

	describe("Other refusal asks nothing", () => {
		const refusedWithNothingWritten = async (h: Gate, reason: string): Promise<void> => {
			const before = (await marked(h)).length;
			const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
			expect(out.isError).toBe(true);
			expect(textOf(out)).toContain(reason);
			expect((await marked(h)).length).toBe(before);
			expect(behaviorTitles(h)).toEqual([]);
		};

		test("dirty tree", async () => {
			const h = await change("define", { answer: "unchanged" });
			await writeIn(h.root, "scratch.txt", "x");
			await refusedWithNothingWritten(h, "dirty");
		});

		test("blocking question", async () => {
			const h = await change("define", { answer: "unchanged", edit: (b) => b.replace("- [x] Q1 (blocking)", "- [ ] Q1 (blocking)") });
			await refusedWithNothingWritten(h, "Q1");
		});

		test("spec-format error", async () => {
			const h = await change("define", { answer: "unchanged", authSpec: "# auth\n\n## Purpose\nNothing.\n\n## Requirements\n" });
			await refusedWithNothingWritten(h, "spec-format");
		});
	});

	test("Changed answer blocks the same call", async () => {
		const h = await change("define", { answer: "changed" });
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("specs/rate-limit/spec.md");
		expect((await behaviorDecisions(h))[0]?.data).toMatchObject({ outcome: "changed" });
		expect(await ofKind(h, "gate")).toEqual([]);
		expect((await ofKind(h, "request")).filter((m) => subjectOf(m) === "gate:define")).toEqual([]);
	});

	test("Behavior answer before a refusal", async () => {
		const h = await change("define", { answer: "changed" });
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(textOf(out)).toContain("behavior-change");
		expect(await behaviorDecisions(h)).toHaveLength(1);
		expect(h.ctx.ui.select.mock.calls.map((c) => c[0]).filter((t) => !t.startsWith(BEHAVIOR_TITLE))).toEqual([]);
	});

	test("Forge request pending", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("decide:behavior-change.rate-limit");
		const requests = await ofKind(h, "request");
		expect(requests.map(subjectOf)).toEqual(["decide:behavior-change.rate-limit"]);
		expect(await behaviorDecisions(h)).toEqual([]);
	});

	test("pending forge request is not asked twice", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		const again = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(again.isError).toBe(true);
		expect(textOf(again)).toContain("decide:behavior-change.rate-limit");
		expect(await ofKind(h, "request")).toHaveLength(1);
	});

	test("New file asks again at the gate", async () => {
		const h = await change("define", { answer: "unchanged", code: [CAP, WINDOW] });
		await seedRecord(h, [CAP], "unchanged");
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(out.isError).toBe(false);
		const decisions = await behaviorDecisions(h);
		expect(decisions).toHaveLength(2);
		expect(decisions[1]?.data).toMatchObject({ outcome: "unchanged", files: [CAP, WINDOW] });
	});

	test("a non-ASCII name with a space is asked about", async () => {
		const file = "src/limits/naïve cap.ts";
		const h = await change("define", { answer: "unchanged", code: [file] });
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(out.isError).toBe(false);
		expect(behaviorTitles(h)).toHaveLength(1);
		expect((await behaviorDecisions(h))[0]?.data).toMatchObject({ outcome: "unchanged", files: [file] });
	});

	test("a rename out of the capability's paths is asked about", async () => {
		const moved = "src/cap.ts";
		const h = await change("define", { answer: "unchanged", code: [], baseFiles: { [CAP]: "export const cap = 100;\n" }, renames: [[CAP, moved]] });
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(out.isError).toBe(false);
		expect(behaviorTitles(h)).toHaveLength(1);
		expect((await behaviorDecisions(h))[0]?.data).toMatchObject({ outcome: "unchanged", files: [CAP] });
	});

	test("reusable record asks nothing", async () => {
		const h = await change("define", { answer: "unchanged" });
		await seedRecord(h, [CAP], "unchanged");
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(out.isError).toBe(false);
		expect(behaviorTitles(h)).toEqual([]);
		expect(await behaviorDecisions(h)).toHaveLength(1);
	});

	test("Flow without the check", async () => {
		const h = await change("define", { answer: "changed", flow: FLOW_WITHOUT_CHECK });
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(out.isError).toBe(false);
		expect(behaviorTitles(h)).toEqual([]);
		expect((await ofKind(h, "request")).map(subjectOf).filter((s) => s.startsWith("decide:behavior-change"))).toEqual([]);
		expect(await behaviorDecisions(h)).toEqual([]);
		expect((await ofKind(h, "gate"))[0]?.data).toMatchObject({ phase: "define", outcome: "approved" });
	});

	test("read-only forge refuses before asking", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		await h.world.makeUnreachable();
		const out = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("read-only");
		await h.world.restore();
		expect(await marked(h)).toEqual([]);
		expect(behaviorTitles(h)).toEqual([]);
	});
});
