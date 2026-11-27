import { afterEach, describe, expect, test } from "vitest";
import { pickByLabel } from "../helpers/menu.ts";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { setHeaderLine } from "../../src/core/sections.ts";
import type { UnitInput } from "../../src/core/unit-blocks.ts";
import { registerBuiltinRules, registerRule, resetRulesForTests } from "../../src/decide/registry.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import type { Subject } from "../../src/interaction/approver.ts";
import { answerComment } from "../../src/interaction/requests.ts";
import { CHANGE_BODY_TEMPLATE } from "../../src/tools/change-new.ts";
import { unitClassification } from "../../src/engine/unit-classification.ts";
import { amendForm, amendRequest, historyUnitIds, planAmend } from "../../src/tools/unit-amend.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import type { SelectFn } from "../hooks/fake-pi.ts";
import { CHANGE_BRANCH } from "../hooks/helpers.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	resetRulesForTests();
	registerBuiltinRules();
	await cleanupDirs();
});

const COVERS = "rate-limit/Requirement: Per-IP cap";
const AT = "2026-11-15T10:00:00.000Z";
const FORGE_CHAIN = "integrationBranch: main\ninteraction: { adapter: [forge] }\n";
const LEVELS = [
	{ id: "low", label: "Low", description: "Low effort." },
	{ id: "medium", label: "Medium", description: "Medium effort." },
	{ id: "high", label: "High", description: "High effort." },
];
const NO_SCHEMA = { validate() {} };

/** Makes `point` ask a human instead of deciding by rule. */
function askingRule(point: string, options = LEVELS): void {
	registerRule(point, NO_SCHEMA, () => ({ ask: { summary: `Which ${point} for U1?`, options, recommended: options[0]!.id, rationale: "Safest default." } }));
}

/** A forge answer to the open decision: `/livespec choose`, then the status refresh that completes it. */
async function answerOnForge(h: Amend, choice: string): Promise<void> {
	await h.world.postComment(h.n, "alice", `/livespec choose ${choice}`);
	const status = await h.call("spec_status");
	expect(status.isError, textOf(status)).toBeFalsy();
}

function unit(title: string, file: string, label: string, extra: Partial<UnitInput> = {}): UnitInput {
	return {
		title,
		covers: [COVERS],
		files: [file],
		done_means: [{ label, text: `${title} works` }],
		scenarios: [{ label, ref: `test/${label}.test.ts › ${title}` }],
		depends: [],
		verify: `bun test ${label}`,
		...extra,
	};
}

const U1 = unit("Counter", "src/limits/counter.ts", "c");
const U2 = unit("Readme note", "README.md", "r");

/** Every select of the in-session human: the request summary picks approve; follow-ups keep everything. */
type Human = { summaries: string[]; pick: string | undefined; menus?: string[][] };

function humanUI(human: Human): { hasUI: true; select: SelectFn } {
	return {
		hasUI: true,
		select: async (title, options) => {
			if (title === "Add notes?") return "No notes";
			if (title === "Adjust Difficulty or Tags?") return "Keep classification";
			human.summaries.push(title);
			human.menus?.push(options);
			return human.pick === undefined ? undefined : pickByLabel(options, human.pick);
		},
	};
}

const DEFAULT_BRIEFING = { summary: "Amends the unit.", recommended: "approve", rationale: "The amendment is small and matches the plan." };
type Amend = ToolHarness & { n: number; human: Human; amend(params: unknown): ReturnType<ToolHarness["call"]> };

/** A planned two-unit change (U1, U2) through plan_units, locked by an approved plan gate unless `locked` is false. `config` sets the approver chain. */
async function planned(o: { locked?: boolean; units?: UnitInput[]; config?: string } = {}): Promise<Amend> {
	const human: Human = { summaries: [], pick: "approve" };
	const h = await toolHarness({ branch: CHANGE_BRANCH, ui: humanUI(human), ...(o.config !== undefined ? { config: o.config } : {}) });
	h.git("config", "user.name", "t");
	h.git("config", "user.email", "t@t");
	h.git("config", `branch.${CHANGE_BRANCH}.livespecBase`, h.head);
	const body = setHeaderLine(setHeaderLine(CHANGE_BODY_TEMPLATE, "Base", h.head), "Branch", CHANGE_BRANCH);
	const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", "livespec:phase/plan"] });
	await h.session.refresh();
	const out = await h.call("plan_units", { units: o.units ?? [U1, U2] });
	if (out.isError) throw new Error(textOf(out));
	const a: Amend = { ...h, n, human, amend: (params) => h.call("unit_amend", { briefing: DEFAULT_BRIEFING, ...(params as object) }) };
	if (o.locked !== false) await lock(a);
	return a;
}

async function lock(h: Amend): Promise<void> {
	const locked = Object.fromEntries(parseChange(await h.world.bodyOf(h.n)).units.map((u) => [u.id, unitDigest(u)]));
	const data = { phase: "plan", outcome: "approved", notes: "", by: "alice", at: AT, adapter: "in-session", head_sha: h.head, waivers: [], locked };
	await h.world.postComment(h.n, BOT_LOGIN, writeMarked("gate", "plan.self-1", data));
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
}

async function marked(h: Amend): Promise<MarkedComment[]> {
	return filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
}

const ofKind = async (h: Amend, kind: string) => (await marked(h)).filter((m) => m.kind === kind);
const units = async (h: Amend) => parseChange(await h.world.bodyOf(h.n)).units;

/** Stores a marked comment on the issue and refreshes the comment cache. */
async function seed(h: Amend, kind: string, id: string, data: unknown): Promise<void> {
	await h.world.postComment(h.n, BOT_LOGIN, writeMarked(kind, id, data));
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
}

/** Adds a question line under `## Questions` through a web edit. */
const addQuestion = (h: Amend, line: string) => webEdit(h, (b) => b.replace("## Questions", `## Questions\n\n${line}`));

/** A request record as plan_units stores it; `mode` is the stored mode, not the question's current class. */
const requestRecord = (id: string, subject: Subject, mode: "async" | "blocking") => ({
	id,
	kind: "question" as const,
	subject,
	mode,
	head_sha: "",
	snapshot: { id: subject, text: "?", requirements: [] },
	summary: "?",
});

/** A refusal: an error naming `text`, no new request comment, no select opened and no amendment written. */
async function expectRefusal(h: Amend, params: unknown, text: string | string[]): Promise<void> {
	const requestsBefore = await ofKind(h, "request");
	const out = await h.amend(params);
	expect(out.isError).toBe(true);
	for (const part of Array.isArray(text) ? text : [text]) expect(textOf(out)).toContain(part);
	expect(await ofKind(h, "request")).toEqual(requestsBefore);
	expect(h.human.summaries).toEqual([]);
	expect(await ofKind(h, "amendment")).toEqual([]);
}

function lockState(h: Amend) {
	const card = h.session.card;
	if (card.kind !== "change") throw new Error(`no change card: ${card.kind}`);
	return card.state.lock;
}

async function webEdit(h: Amend, edit: (body: string) => string): Promise<void> {
	await h.world.editBodyBehindBack(h.n, edit(await h.world.bodyOf(h.n)));
	await h.session.refresh();
}

/** The `unit-classification` results for `unit` over the issue as it is now (a locked plan is in build, where the card does not run the check). */
async function classificationErrors(h: Amend, unit: string) {
	const change = parseChange(await h.world.bodyOf(h.n));
	const results = await unitClassification({ root: h.session.cwd, change, git: h.session.git, marked: await marked(h) });
	return results.filter((r) => r.section === unit);
}

/**
 * A locked plan with U1 `Difficulty: low` and no tags; `unit_amend U1` with an added extra tag (same digest)
 * asks `difficulty.U1` on the forge, the human chooses `high`, and the rerun sends the amendment, still pending.
 */
async function askedAmendment(): Promise<Amend> {
	const h = await planned({ config: FORGE_CHAIN });
	expect((await units(h))[0]).toMatchObject({ difficulty: "low", tags: [] });
	askingRule("difficulty");
	await h.world.setPermission("alice", "write");
	const replacement = { ...U1, extra_tags: ["docs"] };
	expect((await h.amend({ unit: "U1", replacement })).isError).toBe(true);
	await answerOnForge(h, "high");
	expect(await classificationErrors(h, "U1")).toEqual([]);
	const out = await h.amend({ unit: "U1", replacement });
	expect(out.isError, textOf(out)).toBe(false);
	await h.call("spec_status");
	expect((await units(h))[0]?.difficulty).toBe("low");
	return h;
}

const tickU1 = (body: string) => body.replace(/(### U1 — [\s\S]*?)- \[ \] pending/, "$1- [x] done");

describe("unit_amend", () => {
	test("Amendment unfreezes", async () => {
		const h = await planned();
		await webEdit(h, (b) => b.replace("Verify: `bun test r`", "Verify: `bun test readme`"));
		expect(lockState(h).frozen).toEqual(["U2"]);
		const before = unitDigest((await units(h))[1]!);
		const out = await h.amend({ unit: "U2", replacement: { ...U2, verify: "bun test readme" } });
		expect(out.isError).toBe(false);
		const amendment = await ofKind(h, "amendment");
		expect(amendment).toHaveLength(1);
		const after = unitDigest((await units(h))[1]!);
		expect(amendment[0]?.data).toMatchObject({ action: "edit", unit: "U2", old: before, new: after, outcome: "approved" });
		expect(lockState(h).frozen).toEqual([]);
	});

	test("Add and drop", async () => {
		const h = await planned();
		const added = await h.amend({ add: true, replacement: unit("Burst", "src/limits/burst.ts", "b") });
		expect(added.isError).toBe(false);
		expect((await units(h)).map((u) => u.id)).toEqual(["U1", "U2", "U3"]);
		const u3 = (await units(h))[2]!;
		expect(lockState(h).locked?.U3).toBe(unitDigest(u3));
		const dropped = await h.amend({ drop: true, unit: "U1" });
		expect(dropped.isError).toBe(false);
		expect((await units(h)).map((u) => u.id)).toEqual(["U2", "U3"]);
		expect(Object.keys(lockState(h).locked ?? {}).sort()).toEqual(["U2", "U3"]);
		expect(lockState(h).frozen).toEqual([]);
	});

	test("Simplify as a feature", async () => {
		const h = await planned();
		await expectRefusal(h, { add: true, replacement: unit(" Simplify ", "src/limits/simplify.ts", "s") }, "a simplify unit must be Kind: refactor");
		await expectRefusal(h, { unit: "U1", replacement: unit("SIMPLIFY", "src/limits/counter.ts", "c") }, "Kind: refactor");
		expect((await units(h)).map((u) => u.id)).toEqual(["U1", "U2"]);
	});

	test("Simplify as a refactor", async () => {
		const h = await planned();
		const out = await h.amend({ add: true, replacement: unit("simplify", "src/limits/simplify.ts", "s", { kind: "refactor" }) });
		expect(out.isError, textOf(out)).toBe(false);
		expect((await units(h)).map((u) => u.title)).toContain("simplify");
	});

	test("in-session amendments get distinct subjects", async () => {
		const h = await planned();
		await h.amend({ add: true, replacement: unit("Burst", "src/limits/burst.ts", "b") });
		await h.amend({ drop: true, unit: "U1" });
		const subjects = (await ofKind(h, "answer")).map((m) => (m.data as { request: { subject: string } }).request.subject);
		expect(subjects).toEqual(["amend:1", "amend:2"]);
	});

	test("Drop a done unit", async () => {
		const h = await planned();
		await webEdit(h, tickU1);
		const out = await h.amend({ drop: true, unit: "U1" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("done");
		expect(h.human.summaries).toEqual([]);
		expect((await units(h)).map((u) => u.id)).toEqual(["U1", "U2"]);
	});

	test("Invalid replacement", async () => {
		const h = await planned();
		const { verify: _verify, ...noVerify } = U2;
		const out = await h.amend({ unit: "U2", replacement: noVerify });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("units-format");
		expect(h.human.summaries).toEqual([]);
		expect(await ofKind(h, "request")).toEqual([]);
		expect(await ofKind(h, "answer")).toEqual([]);
	});

	test("Drop a depended-on unit", async () => {
		const h = await planned({ units: [U1, U2, unit("Header", "src/limits/header.ts", "h", { depends: ["U1"] })] });
		const out = await h.amend({ drop: true, unit: "U1" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("U3");
		expect(h.human.summaries).toEqual([]);
	});

	test("a dropped id is never reused by an add", async () => {
		const h = await planned();
		expect((await h.amend({ drop: true, unit: "U2" })).isError).toBe(false);
		expect((await h.amend({ add: true, replacement: unit("Burst", "src/limits/burst.ts", "b") })).isError).toBe(false);
		expect((await units(h)).map((u) => u.id)).toEqual(["U1", "U3"]);
	});

	test("refuses before a lock", async () => {
		const h = await planned({ locked: false });
		const out = await h.amend({ unit: "U2", replacement: { ...U2, verify: "bun test readme" } });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("plan_units");
		expect(h.human.summaries).toEqual([]);
	});

	test("refuses a call that is not exactly one form", async () => {
		const h = await planned();
		for (const params of [{}, { unit: "U2" }, { add: true }, { drop: true }, { drop: true, unit: "U1", add: true, replacement: U2 }, { unit: "U9", replacement: U2 }]) {
			expect((await h.amend(params)).isError).toBe(true);
		}
		expect(h.human.summaries).toEqual([]);
	});

	test("only the affected units are in the request", async () => {
		const h = await planned();
		await h.amend({ unit: "U2", replacement: { ...U2, verify: "bun test readme" } });
		expect(h.human.summaries).toHaveLength(1);
		const summary = h.human.summaries[0]!;
		expect(summary).toContain("### U2 — Readme note");
		expect(summary).toContain("Verify: `bun test readme`");
		expect(summary).toContain("Verify: `bun test r`");
		expect(summary.indexOf("Verify: `bun test r`")).toBeLessThan(summary.indexOf("Verify: `bun test readme`"));
		expect(summary.match(/### U2 — Readme note/g)).toHaveLength(2);
		expect(summary).not.toContain("U1");
		expect(summary).not.toContain("Counter");
	});

	test("amending U3 writes records tags.U3 and difficulty.U3", async () => {
		const h = await planned({ units: [U1, U2, unit("Header", "src/limits/header.ts", "h")] });
		const before = (await ofKind(h, "decision")).length;
		const out = await h.amend({ unit: "U3", replacement: unit("Header", "src/auth/header.ts", "h") });
		expect(out.isError).toBe(false);
		const added = (await ofKind(h, "decision")).slice(before);
		expect(added.map((m) => m.id)).toEqual(["tags.U3", "difficulty.U3"]);
		const u3 = (await units(h))[2]!;
		expect(added.map((m) => (m.data as { digest: string }).digest)).toEqual([unitDigest(u3), unitDigest(u3)]);
		expect(u3).toMatchObject({ tags: ["security"], difficulty: "high" });
		const card = h.session.card;
		if (card.kind !== "change") throw new Error("no change card");
		expect(card.state.checks.filter((c) => c.check === "unit-classification")).toEqual([]);
	});

	test("an edit keeps the unit's status line", async () => {
		const h = await planned();
		await webEdit(h, tickU1);
		const out = await h.amend({ unit: "U1", replacement: { ...U1, verify: "bun test counter" } });
		expect(out.isError).toBe(false);
		expect((await units(h))[0]).toMatchObject({ done: true, verify: "bun test counter" });
	});

	test("a dismissed amendment changes nothing", async () => {
		const h = await planned();
		h.human.pick = "dismiss";
		const before = await h.world.bodyOf(h.n);
		await h.amend({ add: true, replacement: unit("Burst", "src/limits/burst.ts", "b") });
		expect(await h.world.bodyOf(h.n)).toBe(before);
		expect(Object.keys(lockState(h).locked ?? {})).toEqual(["U1", "U2"]);
	});

	test("Blocking question keeps the amendment gate closed", async () => {
		const h = await planned();
		await addQuestion(h, "- [ ] Q2 (blocking): x");
		await expectRefusal(h, { unit: "U1", replacement: U1 }, "unit_amend refused: Blocking question Q2 is open: answer it before requesting the gate.");
	});

	test("Stuck report keeps the amendment gate closed", async () => {
		const h = await planned();
		await seed(h, "stuck", "S1", { where: "x", tried: [], hypothesis: "h", options: [{ id: "A", label: "a" }, { id: "B", label: "b" }], recommended: "A" });
		await expectRefusal(h, { add: true, replacement: unit("Extra", "src/x.ts", "x") }, "Stuck report S1 is unanswered");
	});

	test("Iteration cap keeps the amendment gate closed", async () => {
		const h = await planned();
		for (const id of ["Q3", "Q4", "Q5", "Q6", "Q7"]) {
			await seed(h, "stale", id, { reason: id, phases: ["plan"], units: [], after_plan: true });
		}
		await expectRefusal(h, { unit: "U1", replacement: U1 }, "send a stuck report with spec_stuck");
	});

	test("Non-blocking question does not block unit_amend", async () => {
		const h = await planned();
		await addQuestion(h, "- [ ] Q3 (non-blocking): x");
		await seed(h, "request", "question-Q3.lx3k2a", requestRecord("question-Q3.lx3k2a", "question:Q3", "async"));
		const out = await h.amend({ unit: "U1", replacement: U1 });
		expect(out.isError).toBe(false);
		expect(h.human.summaries).toHaveLength(1);
		expect(await ofKind(h, "amendment")).toHaveLength(1);
	});

	test("Applying answer blocks unit_amend", async () => {
		const h = await planned();
		await addQuestion(h, "- [ ] Q3 (non-blocking): x");
		const requestId = "question-Q3.lx3k2a";
		const record = requestRecord(requestId, "question:Q3", "async");
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("request", requestId, record));
		const answer = { status: "answered" as const, outcome: "approved" as const, notes: "", answer: "yes", by: "alice", at: AT, adapter: "in-session" as const };
		await h.world.postComment(h.n, BOT_LOGIN, answerComment(requestId, { request: record, answer, verdict: "valid" }));
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		await expectRefusal(h, { unit: "U1", replacement: U1 }, ["blocking request is pending", "question:Q3"]);
	});

	test("Amendment request kind", async () => {
		const h = await planned({ config: FORGE_CHAIN });
		await h.world.setPermission("alice", "write");
		const out = await h.amend({ unit: "U2", replacement: { ...U2, verify: "bun test readme" } });
		expect(out.isError, textOf(out)).toBe(false);
		const [request] = await ofKind(h, "request");
		expect(request?.data).toMatchObject({ subject: "amend:1", kind: "gate" });
	});

	test("Amendment classification asks on the forge", async () => {
		const h = await planned({ config: FORGE_CHAIN });
		askingRule("difficulty");
		await h.world.setPermission("alice", "write");
		const out = await h.amend({ unit: "U1", replacement: U1 });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("difficulty.U1");
		const decide = (await ofKind(h, "request")).find((m) => (m.data as { subject: string }).subject.startsWith("decide:"));
		expect(textOf(out)).toContain(decide?.id ?? "no decide request");
		expect((await ofKind(h, "request")).some((m) => (m.data as { subject: string }).subject.startsWith("amend:"))).toBe(false);
		expect(await ofKind(h, "amendment")).toEqual([]);
	});

	test("Amendment rerun after a forge answer", async () => {
		const h = await planned({ config: FORGE_CHAIN });
		askingRule("difficulty");
		await h.world.setPermission("alice", "write");
		expect((await h.amend({ unit: "U1", replacement: U1 })).isError).toBe(true);
		await answerOnForge(h, "high");
		const out = await h.amend({ unit: "U1", replacement: U1 });
		expect(out.isError, textOf(out)).toBe(false);
		const gate = (await ofKind(h, "request")).find((m) => (m.data as { subject: string }).subject.startsWith("amend:"));
		const snapshot = (gate?.data as { snapshot: { lines: string[]; records: Record<string, unknown>[] } }).snapshot;
		expect(snapshot.lines).toContain("Difficulty: high");
		expect(snapshot.records.map((r) => r.point)).toEqual(["tags", "difficulty"]);
		expect(snapshot.records[1]).toMatchObject({ source: "human", outcome: "high" });
		expect(snapshot.records[1]).not.toHaveProperty("proposal");
		expect(snapshot.records[1]).not.toHaveProperty("request");
		expect((await ofKind(h, "request")).filter((m) => (m.data as { subject: string }).subject.startsWith("decide:"))).toHaveLength(1);
	});

	test("Dismissed amendment keeps the classification", async () => {
		const h = await askedAmendment();
		expect(await classificationErrors(h, "U1")).toEqual([]);
		await h.world.postComment(h.n, "alice", "/livespec dismiss");
		await h.call("spec_status");
		expect(await h.world.bodyOf(h.n)).toContain("Difficulty: low");
		expect((await units(h))[0]?.difficulty).toBe("low");
		expect(await classificationErrors(h, "U1")).toEqual([]);
	});

	test("Approved amendment applies the answer", async () => {
		const h = await askedAmendment();
		await h.world.postComment(h.n, "alice", "/livespec approve");
		await h.call("spec_status");
		expect((await units(h))[0]).toMatchObject({ difficulty: "high", tags: ["docs"] });
		const digest = unitDigest((await units(h))[0]!);
		const records = (await ofKind(h, "decision")).filter((m) => m.id === "difficulty.U1" && (m.data as { digest?: string }).digest === digest);
		const latest = records.at(-1)?.data;
		expect(latest).toMatchObject({ source: "human", outcome: "high" });
		expect(latest).not.toHaveProperty("proposal");
		expect(await classificationErrors(h, "U1")).toEqual([]);
	});

	test("Rule outcome after a human answer is recorded", async () => {
		const h = await planned();
		const u1 = (await units(h))[0]!;
		expect(u1.difficulty).toBe("low");
		const digest = unitDigest(u1);
		await seed(h, "decision", "difficulty.U1", { point: "difficulty", subject: "U1", digest, source: "human", outcome: "high", facts: {}, reason: "chosen by alice" });
		const before = (await ofKind(h, "decision")).length;
		const out = await h.amend({ unit: "U1", replacement: U1 });
		expect(out.isError, textOf(out)).toBe(false);
		const added = (await ofKind(h, "decision")).slice(before);
		expect(added.map((m) => [m.id, (m.data as { source: string }).source, (m.data as { outcome: unknown }).outcome])).toEqual([["difficulty.U1", "rule", "low"]]);
		expect(await classificationErrors(h, "U1")).toEqual([]);
	});

	test("Added unit keeps its id across an ask", async () => {
		const h = await planned({ config: FORGE_CHAIN });
		askingRule("difficulty");
		await h.world.setPermission("alice", "write");
		const added = unit("Burst", "src/limits/burst.ts", "b");
		expect((await h.amend({ add: true, replacement: added })).isError).toBe(true);
		expect((await ofKind(h, "request")).some((m) => (m.data as { subject: string }).subject === "decide:difficulty.U3")).toBe(true);
		await answerOnForge(h, "high");
		const out = await h.amend({ add: true, replacement: added });
		expect(out.isError, textOf(out)).toBe(false);
		const gate = (await ofKind(h, "request")).find((m) => (m.data as { subject: string }).subject.startsWith("amend:"));
		expect((gate?.data as { snapshot: { unit: string } }).snapshot.unit).toBe("U3");
		expect((await ofKind(h, "request")).filter((m) => (m.data as { subject: string }).subject.startsWith("decide:"))).toHaveLength(1);
		await h.world.postComment(h.n, "alice", "/livespec approve");
		await h.call("spec_status");
		expect((await units(h)).map((u) => u.id)).toEqual(["U1", "U2", "U3"]);
		expect((await units(h))[2]).toMatchObject({ id: "U3", difficulty: "high" });
		expect(await classificationErrors(h, "U3")).toEqual([]);
	});
});

describe("Amendment with a briefing", () => {
	const briefing = { summary: "Tightens the readme verify.", recommended: "approve", rationale: "Only the verify command changes." };
	const edit = { unit: "U2", replacement: { ...U2, verify: "bun test readme" } };

	test("request carries it and the in-session menu recommends approve", async () => {
		const h = await planned();
		h.human.menus = [];
		const out = await h.amend({ ...edit, briefing });
		expect(out.isError, textOf(out)).toBe(false);
		expect(h.human.menus[0]?.[0]).toMatch(/^approve — .* \(Recommended\)$/);
		const [answer] = await ofKind(h, "answer");
		expect(answer?.data).toMatchObject({ request: { briefing: { summary: briefing.summary, author: "agent" } } });
	});

	test("unit_amend without a briefing", async () => {
		const h = await planned({ config: FORGE_CHAIN });
		askingRule("difficulty");
		await h.world.setPermission("alice", "write");
		const out = await h.amend({ ...edit, briefing: undefined });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("briefing");
		expect(await ofKind(h, "request")).toEqual([]);
		expect(await ofKind(h, "amendment")).toEqual([]);
	});

	test("unit_amend briefing without recommended", async () => {
		const h = await planned({ config: FORGE_CHAIN });
		askingRule("difficulty");
		await h.world.setPermission("alice", "write");
		const out = await h.amend({ ...edit, briefing: { summary: "s" } });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("recommended");
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("invalid briefing refused before any decision request", async () => {
		const h = await planned({ config: FORGE_CHAIN });
		askingRule("difficulty");
		await h.world.setPermission("alice", "write");
		for (const bad of [{ summary: "s", recommended: "A", rationale: "r" }, "text"]) {
			const out = await h.amend({ unit: "U1", replacement: U1, briefing: bad });
			expect(out.isError).toBe(true);
			expect(textOf(out)).toContain("briefing");
		}
		expect(await ofKind(h, "request")).toEqual([]);
	});
});

describe("historyUnitIds", () => {
	const decision = (id: string, data: Record<string, unknown>): MarkedComment => ({ commentId: id, kind: "decision", id, author: BOT_LOGIN, data });

	test("skips the answer of a rule ask, keeps rule records and overrides", () => {
		const marked = [
			decision("difficulty.U4", { subject: "U4", source: "human", request: "decide-difficulty-U4.x" }),
			decision("tags.U5", { subject: "U5", source: "rule" }),
			decision("difficulty.U6", { subject: "U6", source: "human" }),
		];
		expect(historyUnitIds(marked)).toEqual(["U5", "U6"]);
	});
});

describe("amendment current values", () => {
	async function plan(h: Amend, params: unknown) {
		const card = h.session.card;
		if (card.kind !== "change") throw new Error("no change card");
		const form = amendForm(params as never);
		if ("refused" in form) throw new Error(form.refused);
		const body = await h.world.bodyOf(h.n);
		const result = await planAmend(card.state, body, form, h.session.pack.ok ? h.session.pack.pack.decisions : {});
		if ("refused" in result) throw new Error(result.refused);
		return amendRequest(card.state, result, body, new Date(0));
	}

	test("edit carries the classified unit's values", async () => {
		const h = await planned();
		const r = await plan(h, { unit: "U1", replacement: { ...U1, extra_tags: ["docs"] } });
		const rendered = (r.record.snapshot as { lines: string[] }).lines;
		expect(r.overridable?.units).toEqual(["U1"]);
		expect(rendered).toContain(`Difficulty: ${r.overridable?.current?.U1?.difficulty}`);
		expect(r.overridable?.current?.U1?.tags).toContain("docs");
	});

	test("add carries the new unit's values", async () => {
		const h = await planned();
		const r = await plan(h, { add: true, replacement: unit("Burst", "src/limits/burst.ts", "b") });
		expect(r.overridable?.units).toEqual(["U3"]);
		expect(Object.keys(r.overridable?.current ?? {})).toEqual(["U3"]);
		expect(r.overridable?.current?.U3?.tags).toBeInstanceOf(Array);
	});

	test("drop has no overridable", async () => {
		const h = await planned();
		expect((await plan(h, { drop: true, unit: "U1" })).overridable).toBeUndefined();
	});
});
