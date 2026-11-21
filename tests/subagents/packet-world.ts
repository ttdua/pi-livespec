// Test world for packet tests: a real git repo with specs, a scriptable in-memory forge and a content tree with skills.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChange } from "../../src/core/change.ts";
import { deriveUnitEvidence } from "../../src/evidence/unit-state.ts";
import { createGit } from "../../src/engine/git.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import type { ChangeState } from "../../src/engine/state-types.ts";
import { filterMarked, type MarkedComment } from "../../src/forge/markers.ts";
import type { Comment, Forge, Issue, PullRequest, ReviewComment, Version } from "../../src/forge/types.ts";
import type { PacketContext } from "../../src/subagents/source-types.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";

export const BOT = "livespec-bot";
export const HUMAN = "alice";
const SPEC_TEXT = readFileSync(new URL("../fixtures/rate-limit.spec.md", import.meta.url), "utf8");
const FIXTURE_BASE = "0123456789abcdef0123456789abcdef01234567";

export type World = {
	ctx: PacketContext;
	forge: Forge;
	issueBody: string;
	issueUpdatedAt: string;
	comments: Map<number, Comment[]>;
	reviewComments: ReviewComment[];
	pulls: PullRequest[];
	prFiles: Map<number, string[]>;
	issues: Map<number, Issue>;
	root: string;
	base: string;
	head: string;
	tree: string;
	post(author: string, body: string, number?: number): Comment;
	setBody(body: string): void;
	/** The context with the state re-derived from the world's body and comments, as a refresh would. */
	refreshed(): PacketContext;
};

export function pack(content: string, buildSkills: string[], reviewerSkills?: string[]): Pack {
	const empty = { requires: [] as string[], skills: { required: [] as string[], optional: [] as string[] }, outputs: [], redirects: [], checks: [] };
	return {
		name: content, version: 1, content, limits: {}, loops: {}, decisions: {}, init: { skills: [] },
		phases: [
			{ ...empty, id: "define", gate: "human", subagents: [{ role: "reviewer", subject: "spec", mode: "always" }] },
			{
				...empty, id: "build", requires: ["define"], per: "unit", gate: "none", skills: { required: buildSkills, optional: [] },
				subagents: [{ role: "implementer", mode: "auto" }, { role: "reviewer", subject: "unit", mode: "auto", ...(reviewerSkills ? { skills: reviewerSkills } : {}) }],
			},
		],
	};
}

export function makeTree(skills: string[]): string {
	const tree = mkdtempSync(join(tmpdir(), "livespec-tree-"));
	for (const name of skills) {
		mkdirSync(join(tree, "skills", name), { recursive: true });
		writeFileSync(join(tree, "skills", name, "SKILL.md"), `# ${name}\n`);
	}
	mkdirSync(join(tree, "agents"), { recursive: true });
	writeFileSync(join(tree, "agents", "code-reviewer.md"), "# code-reviewer\n");
	return tree;
}

export const DEFAULT_SKILLS = ["incremental-implementation", "test-driven-development", "git-workflow-and-versioning", "code-review-and-quality"];

/** Body whose Q2 answer and U3 `Files` mention `src/api/limit.ts`. */
export function bodyWithApiAnswer(): string {
	return FIXTURE_BODY.replace("Should the window be configurable? — Answer: yes", "Should src/api/limit.ts expose the window? — Answer: yes")
		.replace("Files: src/middleware/ratelimit.ts, test/ratelimit.test.ts", "Files: src/middleware/ratelimit.ts, src/api/limit.ts");
}

const git = (root: string, ...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

let counter = 0;
const next = (): Version => `v${++counter}` as Version;

export async function makeWorld(over: { body?: string; pack?: Pack; tree?: string; budget?: number } = {}): Promise<World> {
	const root = await makeRepo();
	await writeIn(root, "specs/rate-limit/spec.md", SPEC_TEXT);
	await writeIn(root, "specs/request-context/spec.md", "---\npaths: [\"src/context.ts\"]\n---\n# request-context\n\n## Purpose\nContext.\n\n## Requirements\n\n### Requirement: Client IP\nThe system SHALL expose the client IP.\n\n#### Scenario: ip\n- **WHEN** a request arrives\n- **THEN** the IP is set\n")
	await writeIn(root, "specs/constraints.md", "# Constraints\nNo new dependencies.\n");
	await writeIn(root, "specs/product.md", "# Product\nA rate limiter.\n");
	commitAll(root, "base");
	const base = git(root, "rev-parse", "HEAD");
	await writeIn(root, "specs/rate-limit/spec.md", `${SPEC_TEXT}\n### Requirement: Burst\nThe system SHALL allow bursts of 10.\n`);
	await writeIn(root, "src/middleware/ratelimit.ts", "export const limit = 100;\n");
	commitAll(root, "work");
	const head = git(root, "rev-parse", "HEAD");
	const world = {
		issueBody: (over.body ?? FIXTURE_BODY).replace(FIXTURE_BASE, base), issueUpdatedAt: "t0",
		comments: new Map<number, Comment[]>(), reviewComments: [], pulls: [], prFiles: new Map<number, string[]>(), issues: new Map<number, Issue>(), root, base, head,
	} as unknown as World;
	world.forge = scriptedForge(world);
	world.tree = over.tree ?? makeTree(DEFAULT_SKILLS);
	world.post = (author, body, number = 7) => {
		const list = world.comments.get(number) ?? [];
		const comment: Comment = { id: `c${++counter}`, author, body, createdAt: "t", updatedAt: String(counter), version: next() };
		world.comments.set(number, [...list, comment]);
		return comment;
	};
	world.setBody = (body) => {
		world.issueBody = body;
		world.issueUpdatedAt = String(++counter);
	};
	const defaultPack = pack("agent-skills", ["incremental-implementation", "test-driven-development", "git-workflow-and-versioning"], ["code-review-and-quality"]);
	const baseCtx = { session: { activeTree: world.tree }, pack: over.pack ?? defaultPack, forge: world.forge, git: createGit(root), root, cwd: root, budgetTokens: over.budget ?? 24000 };
	world.refreshed = () => ({ ...baseCtx, state: stateOf(world) });
	world.ctx = world.refreshed();
	return world;
}

function stateOf(world: World): ChangeState {
	const marked: MarkedComment[] = filterMarked(world.comments.get(7) ?? [], BOT).comments;
	const start = (unit: string) => ({ id: `${unit}.s`, commentId: "s", index: 0, unit, digest: "d", verify: "v", pre: { sha: world.base } });
	const state = stateFor("build", { git: { branch: "livespec/per-ip-cap", head: world.head, dirty: false, specsChanged: true }, marked }, world.issueBody);
	return { ...state, change: parseChange(world.issueBody), evidence: { ...state.evidence, receipts: deriveUnitEvidence(parseChange(world.issueBody), marked, undefined).receipts, started: { U3: start("U3") } } };
}

function scriptedForge(world: World): Forge {
	const issue = (n: number): Issue =>
		world.issues.get(n) ?? { number: n, title: `issue ${n}`, body: n === 7 ? world.issueBody : `body of ${n}`, labels: [], state: "open", author: HUMAN, updatedAt: world.issueUpdatedAt, version: world.issueUpdatedAt as Version };
	const forge: Partial<Forge> = {
		kind: "github",
		whoami: async () => ({ login: BOT }),
		getIssue: async (n) => issue(n),
		searchIssues: async (q) => [...world.issues.values()].filter((i) => q.state === undefined || q.state === "all" || i.state === q.state),
		listComments: async (n) => [...(world.comments.get(n) ?? [])],
		findOpenPullRequest: async () => null,
		getPullRequest: async (n) => ({ number: n, state: "open", merged: false, head: "h", base: "b", title: "the pr", body: "pr body", author: HUMAN, version: "p1" as Version }),
		listPullRequests: async (q) => world.pulls.filter((p) => q.state === "all" || p.state === q.state),
		listReviewComments: async () => [...world.reviewComments],
		listReviews: async () => [],
		getPullRequestFiles: async (n) => world.prFiles.get(n) ?? [],
		getChecks: async () => ({ state: "none", checks: [] }),
	};
	return forge as Forge;
}
