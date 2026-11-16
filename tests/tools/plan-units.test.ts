import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { setHeaderLine } from "../../src/core/sections.ts";
import { registerBuiltinRules, registerRule, resetRulesForTests } from "../../src/decide/registry.ts";
import type { UnitInput } from "../../src/core/unit-blocks.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { createGit } from "../../src/engine/git.ts";
import { ForgeError } from "../../src/forge/errors.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { answerComment } from "../../src/interaction/requests.ts";
import { CHANGE_BODY_TEMPLATE } from "../../src/tools/change-new.ts";
import { reconcileBase } from "../../src/tools/plan-units-steps.ts";
import type { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { CHANGE_BRANCH } from "../hooks/helpers.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import type { FakeUI } from "../hooks/fake-pi.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	resetRulesForTests();
	registerBuiltinRules();
	await cleanupDirs();
});

const BASE_KEY = `branch.${CHANGE_BRANCH}.livespecBase`;
const COVERS = "rate-limit/Requirement: Per-IP cap";

const U1: UnitInput = {
	title: "Token check",
	covers: [COVERS],
	files: ["src/auth/token.ts"],
	done_means: [{ label: "t", text: "a forged token is rejected" }],
	scenarios: [{ label: "t", ref: "test/auth.test.ts › rejects forged" }],
	depends: [],
	verify: "bun test auth",
};
const U2: UnitInput = {
	title: "Readme note",
	covers: [COVERS],
	files: ["README.md"],
	done_means: [{ label: "r", text: "the readme lists the limit" }],
	scenarios: [{ label: "r", ref: "test/readme.test.ts › lists the limit" }],
	depends: ["U1"],
	verify: "bun test readme",
};

/** `next` decides how the next `updateIssueBody` fails. */
type Fault = { next: "none" | "conflict" | "lost"; comment?: boolean; editOnComment?: boolean };

function faultyForge(fault: Fault, n: () => number): (world: MemoryWorld) => Forge {
	return (world) =>
		new Proxy(world.forge, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				if (prop === "createComment") {
					return async (...args: unknown[]) => {
						if (fault.comment) throw new ForgeError({ code: "http", operation: "createComment", message: "bad gateway", status: 502 });
						const created = await value.apply(target, args);
						if (fault.editOnComment) {
							fault.editOnComment = false;
							await world.editBodyBehindBack(n(), `${await world.bodyOf(n())}edited elsewhere\n`);
						}
						return created;
					};
				}
				if (prop !== "updateIssueBody") return value.bind(target);
				return async (...args: unknown[]) => {
					const f = fault.next;
					fault.next = "none";
					if (f === "conflict") await world.editBodyBehindBack(n(), `${await world.bodyOf(n())}edited elsewhere\n`);
					if (f === "lost") throw new ForgeError({ code: "http", operation: "updateIssueBody", message: "bad gateway", status: 502 });
					return value.apply(target, args);
				};
			},
		});
}

type Plan = ToolHarness & { n: number; base: string; fault: Fault; plan(units?: UnitInput[]): ReturnType<ToolHarness["call"]> };

/** A started change on its branch: `Branch`, `Base` and the `livespecBase` config set as change_start leaves them. */
async function planning(phase = "plan", config?: string, ui?: FakeUI): Promise<Plan> {
	const fault: Fault = { next: "none" };
	let n = 0;
	const h = await toolHarness({ branch: CHANGE_BRANCH, forge: faultyForge(fault, () => n), ...(config !== undefined ? { config } : {}), ...(ui ? { ui } : {}) });
	h.git("config", "user.name", "t");
	h.git("config", "user.email", "t@t");
	const base = h.head;
	h.git("config", BASE_KEY, base);
	const body = setHeaderLine(setHeaderLine(CHANGE_BODY_TEMPLATE, "Base", base), "Branch", CHANGE_BRANCH);
	n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", `livespec:phase/${phase}`] });
	await h.session.refresh();
	return { ...h, n, base, fault, plan: (units = [U1, U2]) => h.call("plan_units", { units }) };
}

/** Pushes a commit to `origin/main` that touches `file`, leaving the change branch checked out. */
async function advanceIntegration(h: Plan, file = "upstream.txt", text = "upstream\n"): Promise<string> {
	h.git("switch", "-q", "main");
	await writeIn(h.root, file, text);
	commitAll(h.root, "upstream");
	h.git("push", "-q", "origin", "main");
	const sha = h.git("rev-parse", "HEAD");
	h.git("switch", "-q", CHANGE_BRANCH);
	return sha;
}

async function marked(h: Plan): Promise<MarkedComment[]> {
	return filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
}

const decisions = async (h: Plan) => (await marked(h)).filter((m) => m.kind === "decision");
const issueBody = (h: Plan) => h.world.bodyOf(h.n);
const baseConfig = (h: Plan) => h.git("config", "--get", BASE_KEY);
const isAncestor = (h: Plan, a: string): boolean => {
	try {
		h.git("merge-base", "--is-ancestor", a, "HEAD");
		return true;
	} catch {
		return false;
	}
};

describe("plan_units", () => {
	test("Units written with classification", async () => {
		const h = await planning();
		const out = await h.plan();
		expect(out.isError).toBe(false);
		const [u1, u2] = parseChange(await issueBody(h)).units;
		expect(u1).toMatchObject({ id: "U1", tags: ["security"], difficulty: "high", done: false });
		expect(u2).toMatchObject({ id: "U2", tags: [], difficulty: "low", done: false, depends: ["U1"] });
		const records = await decisions(h);
		expect(records.map((m) => m.id)).toEqual(["tags.U1", "difficulty.U1", "tags.U2", "difficulty.U2"]);
		expect(records.map((m) => (m.data as { source: string }).source)).toEqual(["rule", "rule", "rule", "rule"]);
		const { state } = h.session.card.kind === "change" ? h.session.card : { state: undefined };
		expect(state?.checks.filter((c) => c.check === "unit-classification")).toEqual([]);
	});

	test("Base is an ancestor of HEAD", async () => {
		const h = await planning();
		const upstream = await advanceIntegration(h);
		expect((await h.plan()).isError).toBe(false);
		const base = parseChange(await issueBody(h)).header.base;
		expect(base).toBe(upstream);
		expect(isAncestor(h, upstream)).toBe(true);
		expect(baseConfig(h)).toBe(upstream);
		expect(h.git("status", "--porcelain")).toBe("");
	});

	test("Unknown outcome with an unchanged base", async () => {
		const h = await planning();
		const before = await issueBody(h);
		h.fault.next = "lost";
		const out = await h.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("Rerun plan_units to reconcile");
		expect(await issueBody(h)).toBe(before);
		expect(baseConfig(h)).toBe(h.base);
	});

	test("unknown outcome that the re-read confirms reports success", async () => {
		const h = await planning();
		const upstream = await advanceIntegration(h);
		const world = h.world;
		const inner = world.forge.updateIssueBody.bind(world.forge);
		world.forge.updateIssueBody = async (...args) => {
			await inner(...args);
			throw new ForgeError({ code: "http", operation: "updateIssueBody", message: "cannot parse response", status: 200 });
		};
		const out = await h.plan();
		expect(out.isError).toBe(false);
		expect(baseConfig(h)).toBe(upstream);
	});

	test("a rerun repairs a config left behind by an unknown outcome, even when it then refuses", async () => {
		const h = await planning();
		const upstream = await advanceIntegration(h);
		h.git("merge", "-q", "--no-edit", "origin/main");
		await h.world.editBodyBehindBack(h.n, setHeaderLine(await issueBody(h), "Base", upstream));
		await writeIn(h.root, "scratch.txt", "x\n");
		await h.session.refresh();
		expect(baseConfig(h)).toBe(h.base);
		const out = await h.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("uncommitted");
		expect(baseConfig(h)).toBe(upstream);
	});

	test("Write conflict keeps the base consistent", async () => {
		const h = await planning();
		await advanceIntegration(h);
		h.fault.next = "conflict";
		const out = await h.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("Version conflict");
		expect(parseChange(await issueBody(h)).header.base).toBe(h.base);
		expect(baseConfig(h)).toBe(h.base);
	});

	test("Change start still reconciles", async () => {
		const h = await planning();
		const upstream = await advanceIntegration(h);
		expect((await h.plan()).isError).toBe(false);
		const before = await issueBody(h);
		const out = await h.call("change_start", { issue: h.n });
		expect(out.isError).toBe(false);
		expect(textOf(out)).toContain("Reconciled");
		expect(textOf(out)).not.toContain("records Branch");
		expect(await issueBody(h)).toBe(before);
		expect(baseConfig(h)).toBe(upstream);
	});

	test("Merge conflict", async () => {
		const h = await planning();
		await writeIn(h.root, "README.md", "branch\n");
		commitAll(h.root, "branch readme");
		const head = h.git("rev-parse", "HEAD");
		await advanceIntegration(h, "README.md", "upstream\n");
		const before = await issueBody(h);
		const out = await h.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("conflicts");
		expect(h.git("rev-parse", "HEAD")).toBe(head);
		expect(h.git("status", "--porcelain")).toBe("");
		expect(await issueBody(h)).toBe(before);
		expect(await marked(h)).toEqual([]);
	});

	test("Invalid unit", async () => {
		const h = await planning();
		await advanceIntegration(h);
		const head = h.git("rev-parse", "HEAD");
		const before = await issueBody(h);
		const { verify: _verify, ...noVerify } = U2;
		const out = await h.plan([U1, noVerify as UnitInput]);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("units-format");
		expect(textOf(out)).toContain("U2");
		expect(h.git("rev-parse", "HEAD")).toBe(head);
		expect(await issueBody(h)).toBe(before);
		expect(await marked(h)).toEqual([]);
	});

	test("Locked plan", async () => {
		const h = await planning();
		const data = { phase: "plan", outcome: "approved", notes: "", by: "alice", at: "2026-11-15T10:00:00.000Z", adapter: "in-session", head_sha: h.head, waivers: [], locked: {} };
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("gate", "plan.self-1", data));
		await h.session.comments?.invalidate(h.n);
		const out = await h.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("unit_amend");
		expect(await decisions(h)).toEqual([]);
	});

	test("Agent cannot remove a tag", async () => {
		const h = await planning();
		expect((await h.plan([{ ...U1, extra_tags: ["perf"] }])).isError).toBe(false);
		const u1 = parseChange(await issueBody(h)).units[0];
		expect(u1?.tags).toEqual(["security", "perf"]);
		const tags = (await decisions(h)).find((m) => m.id === "tags.U1");
		expect((tags?.data as { agent_additions?: string[] }).agent_additions).toEqual(["perf"]);
	});

	test("a non-kebab extra tag is refused before anything is written", async () => {
		const h = await planning();
		const out = await h.plan([{ ...U1, extra_tags: ["Not Kebab"] }]);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("kebab-case");
		expect(await marked(h)).toEqual([]);
	});

	test("refuses when the integration branch is unknown", async () => {
		const h = await planning("plan", "# no integrationBranch\n");
		const head = h.git("rev-parse", "HEAD");
		const out = await h.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("integration branch is unknown");
		expect(h.git("rev-parse", "HEAD")).toBe(head);
		expect(await marked(h)).toEqual([]);
	});

	test("posting decision records bumps the issue version and the plan still writes Units and Base", async () => {
		const h = await planning();
		const upstream = await advanceIntegration(h);
		const before = await h.world.forge.getIssue(h.n);
		const out = await h.plan();
		expect(textOf(out)).not.toContain("Version conflict");
		expect(out.isError).toBe(false);
		const change = parseChange(await issueBody(h));
		expect(change.units.map((u) => u.id)).toEqual(["U1", "U2"]);
		expect(change.header.base).toBe(upstream);
		expect(baseConfig(h)).toBe(upstream);
		expect((await h.world.forge.getIssue(h.n)).version).not.toBe(before.version);
	});

	test("a body edited while the records are posted refuses as a conflict", async () => {
		const h = await planning();
		await advanceIntegration(h);
		h.fault.editOnComment = true;
		const out = await h.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("Version conflict");
		const body = await issueBody(h);
		expect(body).toContain("edited elsewhere");
		expect(parseChange(body).header.base).toBe(h.base);
		expect(parseChange(body).units).toEqual([]);
		expect(baseConfig(h)).toBe(h.base);
	});

	test("a failed decision record after the merge refuses and asks for a rerun", async () => {
		const h = await planning();
		const upstream = await advanceIntegration(h);
		const before = await issueBody(h);
		h.fault.comment = true;
		const out = await h.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("Rerun plan_units");
		expect(await issueBody(h)).toBe(before);
		expect(baseConfig(h)).toBe(h.base);
		h.fault.comment = false;
		expect((await h.plan()).isError).toBe(false);
		expect(baseConfig(h)).toBe(upstream);
	});

	test("refuses outside plan", async () => {
		const h = await planning("define");
		const out = await h.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("issue#Units");
		expect(parseChange(await issueBody(h)).units).toEqual([]);
	});

	test("refuses on a dirty tree", async () => {
		const h = await planning();
		await writeIn(h.root, "scratch.txt", "x\n");
		await h.session.refresh();
		const out = await h.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("uncommitted");
		expect(await marked(h)).toEqual([]);
	});

	test("refuses while a request is pending", async () => {
		const h = await planning();
		const request = { kind: "question", subject: "question:Q1" as const, mode: "blocking", head_sha: h.head, snapshot: { id: "Q1", text: "?", requirements: [] }, summary: "?" };
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("request", "question-Q1.lx3k2a", request));
		await h.session.comments?.invalidate(h.n);
		const out = await h.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("pending");
	});

	/** Adds `line` under `## Questions` in the issue body, behind the bot's back, then refreshes the session. */
	async function addQuestion(h: Plan, line: string): Promise<void> {
		await h.world.editBodyBehindBack(h.n, (await issueBody(h)).replace("## Questions", `## Questions\n\n${line}`));
		await h.session.refresh();
	}

	/** Stores a request comment for `subject` with `mode` and refreshes the comment cache. */
	async function storeRequest(h: Plan, id: string, subject: string, kind: string, mode: string): Promise<void> {
		const request = { kind, subject, mode, head_sha: h.head, snapshot: { id: subject, text: "?", requirements: [] }, summary: "?" };
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("request", id, request));
		await h.session.comments?.invalidate(h.n);
	}

	test("Non-blocking question does not block plan_units", async () => {
		const h = await planning();
		await addQuestion(h, "- [ ] Q1 (non-blocking): x");
		await storeRequest(h, "question-Q1.lx3k2a", "question:Q1", "question", "async");
		const out = await h.plan();
		expect(out.isError).toBe(false);
		expect(parseChange(await issueBody(h)).units).toHaveLength(2);
	});

	test("Reclassified question follows its current class", async () => {
		const h = await planning();
		await addQuestion(h, "- [ ] Q1 (non-blocking): x");
		await storeRequest(h, "question-Q1.lx3k2a", "question:Q1", "question", "blocking");
		const written = await h.plan();
		expect(written.isError).toBe(false);
		expect(parseChange(await issueBody(h)).units).toHaveLength(2);

		const g = await planning();
		await addQuestion(g, "- [ ] Q2 (blocking): y");
		await storeRequest(g, "question-Q2.lx3k2a", "question:Q2", "question", "async");
		const out = await g.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("question:Q2");
		expect(parseChange(await issueBody(g)).units).toEqual([]);
	});

	test("Applying non-blocking answer blocks plan_units", async () => {
		const h = await planning();
		await addQuestion(h, "- [ ] Q1 (non-blocking): x");
		const requestId = "question-Q1.lx3k2a";
		const record = { id: requestId, kind: "question" as const, subject: "question:Q1" as const, mode: "async" as const, head_sha: h.head, snapshot: { id: "Q1", text: "?", requirements: [] }, summary: "?" };
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("request", requestId, record));
		const answer = { status: "answered" as const, outcome: "approved" as const, notes: "", answer: "yes", by: "alice", at: "t", adapter: "in-session" as const };
		await h.world.postComment(h.n, BOT_LOGIN, answerComment(requestId, { request: record, answer, verdict: "valid" }));
		await h.session.comments?.invalidate(h.n);
		const out = await h.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("question:Q1");
		expect(parseChange(await issueBody(h)).units).toEqual([]);
	});

	test.each([
		["gate:plan", "gate"],
		["amend:1", "gate"],
		["stuck:S1", "stuck"],
		["decide:tags.U1", "gate"],
	])("Non-question request %s blocks whatever its stored mode", async (subject, kind) => {
		const h = await planning();
		await storeRequest(h, "req-1.lx3k2a", subject, kind, "async");
		const out = await h.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(subject);
		expect(parseChange(await issueBody(h)).units).toEqual([]);
	});

	test("Request for a missing question blocks", async () => {
		const h = await planning();
		await storeRequest(h, "question-Q9.lx3k2a", "question:Q9", "question", "async");
		const out = await h.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("question:Q9");
	});
});

const FORGE_CHAIN = "integrationBranch: main\ninteraction: { adapter: [forge] }\n";
const SESSION_CHAIN = "integrationBranch: main\ninteraction: { adapter: [in-session] }\n";
const LEVELS = [
	{ id: "low", label: "Low" },
	{ id: "medium", label: "Medium" },
	{ id: "high", label: "High" },
];
const NO_SCHEMA = { validate() {} };
const selectingId = (id: string): FakeUI => ({ hasUI: true, select: async (_t, options) => options.find((o) => o.endsWith(`[${id}]`)) });

/** Makes `point` ask a human instead of deciding by rule. */
function askingRule(point: string, options = LEVELS): void {
	registerRule(point, NO_SCHEMA, () => ({ ask: { summary: `Which ${point} for U1?`, options } }));
}

const requestsOf = async (h: Plan) => (await marked(h)).filter((m) => m.kind === "request");
const humanDecision = async (h: Plan, id: string) => (await decisions(h)).find((m) => m.id === id);

async function answerOnForge(h: Plan, choice: string): Promise<void> {
	await h.world.postComment(h.n, "alice", `/livespec choose ${choice}`);
	const status = await h.call("spec_status");
	expect(status.isError, textOf(status)).toBeFalsy();
}

describe("plan_units asks classification", () => {
	test("Classification asks on the forge", async () => {
		askingRule("difficulty");
		const h = await planning("plan", FORGE_CHAIN);
		await h.world.setPermission("alice", "write");
		const before = await issueBody(h);
		const head = h.git("rev-parse", "HEAD");
		const out = await h.plan([U1]);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("difficulty.U1");
		expect(textOf(out)).toContain("decide-difficulty-U1.");
		expect(h.git("rev-parse", "HEAD")).toBe(head);
		expect(await issueBody(h)).toBe(before);
		expect(await decisions(h)).toEqual([]);
	});

	test("Rerun after a forge answer", async () => {
		askingRule("difficulty");
		const h = await planning("plan", FORGE_CHAIN);
		await h.world.setPermission("alice", "write");
		expect((await h.plan([U1])).isError).toBe(true);
		await answerOnForge(h, "high");
		const out = await h.plan([U1]);
		expect(out.isError, textOf(out)).toBe(false);
		expect(parseChange(await issueBody(h)).units[0]).toMatchObject({ id: "U1", difficulty: "high" });
		expect(await requestsOf(h)).toHaveLength(1);
		const records = await decisions(h);
		expect(records.map((m) => [m.id, (m.data as { source: string }).source]).sort()).toEqual([
			["difficulty.U1", "human"],
			["tags.U1", "rule"],
		]);
		const digest = unitDigest(parseChange(await issueBody(h)).units[0]!);
		expect((await humanDecision(h, "difficulty.U1"))?.data).toMatchObject({ digest });
		const { state } = h.session.card.kind === "change" ? h.session.card : { state: undefined };
		expect(state?.checks.filter((c) => c.check === "unit-classification")).toEqual([]);
	});

	test("Classification answered in session", async () => {
		askingRule("difficulty");
		const h = await planning("plan", SESSION_CHAIN, selectingId("high"));
		const out = await h.plan([U1]);
		expect(out.isError, textOf(out)).toBe(false);
		expect(parseChange(await issueBody(h)).units[0]).toMatchObject({ difficulty: "high" });
		const difficulty = (await decisions(h)).filter((m) => m.id === "difficulty.U1");
		expect(difficulty).toHaveLength(1);
		expect(difficulty[0]?.data).toMatchObject({ source: "human", outcome: "high" });
	});

	test("Tags answer that is not a list of tags", async () => {
		askingRule("tags", [{ id: "x", label: "X" }]);
		const h = await planning("plan", SESSION_CHAIN, selectingId("x"));
		const before = await issueBody(h);
		const head = h.git("rev-parse", "HEAD");
		const out = await h.plan([U1]);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("tags.U1");
		expect(textOf(out)).toContain("not a list of tags");
		expect(h.git("rev-parse", "HEAD")).toBe(head);
		expect(await issueBody(h)).toBe(before);
	});

	test("Answer kept across a refused run", async () => {
		askingRule("difficulty");
		const h = await planning("plan", SESSION_CHAIN, selectingId("high"));
		await writeIn(h.root, "README.md", "branch\n");
		commitAll(h.root, "branch readme");
		await advanceIntegration(h, "README.md", "upstream\n");
		const refused = await h.plan([U1]);
		expect(textOf(refused)).toContain("conflicts");
		expect(await humanDecision(h, "difficulty.U1")).toBeDefined();
		h.git("reset", "-q", "--hard", "HEAD~1");
		await h.session.refresh();
		const out = await h.plan([U1]);
		expect(out.isError, textOf(out)).toBe(false);
		expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
		expect(parseChange(await issueBody(h)).units[0]).toMatchObject({ difficulty: "high" });
	});

	test("Changed tags change the difficulty question", async () => {
		askingRule("difficulty");
		const h = await planning("plan", FORGE_CHAIN);
		await h.world.setPermission("alice", "write");
		expect((await h.plan([U1])).isError).toBe(true);
		await answerOnForge(h, "high");
		const out = await h.plan([{ ...U1, extra_tags: ["ui"] }]);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("decide-difficulty-U1.");
		expect(await requestsOf(h)).toHaveLength(2);
	});
});

describe("reconcileBase", () => {
	test("equal config, a non-ancestor and an unknown commit are no-ops", async () => {
		const h = await planning();
		const git = createGit(h.root);
		expect(await reconcileBase(git, CHANGE_BRANCH, h.base)).toBe(false);
		expect(await reconcileBase(git, CHANGE_BRANCH, undefined)).toBe(false);
		const upstream = await advanceIntegration(h);
		expect(await reconcileBase(git, CHANGE_BRANCH, upstream)).toBe(false);
		expect(await reconcileBase(git, CHANGE_BRANCH, "0".repeat(40))).toBe(false);
		expect(baseConfig(h)).toBe(h.base);
		h.git("merge", "-q", "--no-edit", "origin/main");
		expect(await reconcileBase(git, CHANGE_BRANCH, upstream)).toBe(true);
		expect(baseConfig(h)).toBe(upstream);
	});
});
