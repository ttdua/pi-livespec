import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { setHeaderLine } from "../../src/core/sections.ts";
import type { UnitInput } from "../../src/core/unit-blocks.ts";
import { createGit } from "../../src/engine/git.ts";
import { ForgeError } from "../../src/forge/errors.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { CHANGE_BODY_TEMPLATE } from "../../src/tools/change-new.ts";
import { reconcileBase } from "../../src/tools/plan-units-steps.ts";
import type { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { CHANGE_BRANCH } from "../hooks/helpers.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
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
async function planning(phase = "plan", config?: string): Promise<Plan> {
	const fault: Fault = { next: "none" };
	let n = 0;
	const h = await toolHarness({ branch: CHANGE_BRANCH, forge: faultyForge(fault, () => n), ...(config !== undefined ? { config } : {}) });
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
		const request = { kind: "question", subject: "question:Q1", mode: "blocking", head_sha: h.head, snapshot: { id: "Q1", text: "?", requirements: [] }, summary: "?" };
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("request", "question-Q1.lx3k2a", request));
		await h.session.comments?.invalidate(h.n);
		const out = await h.plan();
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("pending");
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
