// ContractWorld backed by the fake `gh` script and its JSON state file.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GitHubForge, type ExecFn, defaultExec } from "../../src/forge/github.ts";
import type { ReviewComment } from "../../src/forge/types.ts";
import { type FakeGhData, FakeGhStore, type IssueRec, type PullRec, emptyData, tick } from "./fake-gh/state.ts";
import {
	BOT_LOGIN,
	type ContractWorld,
	OTHER_LOGIN,
	type SeedIssue,
	type SeedPullRequest,
	type SeedReview,
	type SeedStatus,
} from "./world.ts";

export const FAKE_GH_PATH = resolve(import.meta.dirname, "fake-gh", "gh");
export const REPO = { owner: "acme", repo: "widgets" };

const REVIEW_STATES = { approved: "APPROVED", changes_requested: "CHANGES_REQUESTED", commented: "COMMENTED" } as const;

export class GitHubWorld implements ContractWorld {
	readonly forge: GitHubForge;
	readonly store: FakeGhStore;
	private readonly dir: string;

	constructor(opts: { hostname?: string } = {}) {
		this.dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
		this.store = new FakeGhStore(join(this.dir, "state.json"));
		this.store.init(emptyData(`${REPO.owner}/${REPO.repo}`, BOT_LOGIN));
		const exec: ExecFn = (file, args, input) => defaultExecWithState(this.store.path, file, args, input);
		this.forge = new GitHubForge({ ghPath: FAKE_GH_PATH, repo: REPO, exec, hostname: opts.hostname });
	}

	/** argv of every fake `gh` invocation, in order. */
	argvLog(): string[][] {
		return this.store.read().argvLog;
	}

	/** Calls the adapter has made through the fake `gh api`, in order. */
	calls(): FakeGhData["calls"] {
		return this.store.read().calls;
	}

	async seedIssue(issue: SeedIssue = {}): Promise<number> {
		return this.store.update((d) => {
			const labels = issue.labels ?? [];
			for (const label of labels) if (!d.labels.includes(label)) d.labels.push(label);
			const number = d.nextNumber++;
			const now = tick(d);
			const rec: IssueRec = {
				number,
				title: issue.title ?? `issue ${number}`,
				body: issue.body ?? "",
				labels: [...labels],
				state: issue.state ?? "open",
				author: issue.author ?? OTHER_LOGIN,
				createdAt: now,
				updatedAt: now,
			};
			d.issues[String(number)] = rec;
			return number;
		});
	}

	async editBodyBehindBack(n: number, body: string): Promise<void> {
		this.store.update((d) => {
			const issue = d.issues[String(n)];
			issue.body = body;
			issue.updatedAt = tick(d);
		});
	}

	async bodyOf(n: number): Promise<string> {
		return this.store.read().issues[String(n)].body;
	}

	async postComment(n: number, author: string, body: string): Promise<string> {
		return this.store.update((d) => {
			const id = d.nextCommentId++;
			const now = tick(d);
			d.comments[String(id)] = { id, issue: n, author, body, createdAt: now, updatedAt: now };
			return String(id);
		});
	}

	async commentBodyOf(id: string): Promise<string> {
		return this.store.read().comments[id].body;
	}

	async hasLabel(name: string): Promise<boolean> {
		return this.store.read().labels.includes(name);
	}

	async dropLabel(name: string): Promise<void> {
		this.store.update((d) => {
			d.labels = d.labels.filter((l) => l !== name);
			for (const issue of Object.values(d.issues)) issue.labels = issue.labels.filter((l) => l !== name);
		});
	}

	async labelCreateCount(name: string): Promise<number> {
		return this.store.read().labelCreates[name] ?? 0;
	}

	async seedPullRequest(pr: SeedPullRequest): Promise<number> {
		return this.store.update((d) => {
			const number = d.nextNumber++;
			const now = tick(d);
			const rec: PullRec = {
				number,
				state: pr.state ?? "open",
				merged: pr.merged ?? false,
				head: pr.head,
				base: pr.base ?? "main",
				title: pr.title ?? `pull ${number}`,
				body: pr.body ?? "",
				author: OTHER_LOGIN,
				files: pr.files ?? [],
				reviews: [],
				reviewComments: [],
				createdAt: now,
				updatedAt: now,
			};
			if (rec.merged) rec.mergedAt = now;
			d.pulls[String(number)] = rec;
			return number;
		});
	}

	async editPullRequestBodyBehindBack(n: number, body: string): Promise<void> {
		this.store.update((d) => {
			const pull = d.pulls[String(n)];
			pull.body = body;
			pull.updatedAt = tick(d);
		});
	}

	async seedReview(pr: number, review: SeedReview): Promise<void> {
		this.store.update((d) => {
			d.pulls[String(pr)].reviews.push({ author: review.author, state: REVIEW_STATES[review.state], body: review.body });
		});
	}

	/** Alternates between commit statuses and check runs so both endpoints are exercised. */
	async seedStatus(ref: string, status: SeedStatus): Promise<void> {
		this.store.update((d) => {
			const list = d.statuses[ref] ?? [];
			list.push({ ...status, checkRun: list.length % 2 === 1 });
			d.statuses[ref] = list;
		});
	}

	async reviewCommentsOf(pr: number): Promise<ReviewComment[]> {
		return this.store.read().pulls[String(pr)].reviewComments;
	}

	async setPermission(login: string, level: "none" | "read" | "write" | "admin"): Promise<void> {
		this.store.update((d) => {
			d.permissions[login] = level;
		});
	}

	async makeUnreachable(): Promise<void> {
		this.store.update((d) => {
			d.unreachable = true;
		});
	}

	async restore(): Promise<void> {
		this.store.update((d) => {
			d.unreachable = false;
		});
	}

	/** Makes `gh auth status` fail, as when nobody is logged in. */
	async logout(): Promise<void> {
		this.store.update((d) => {
			d.authenticated = false;
		});
	}

	async dispose(): Promise<void> {
		rmSync(this.dir, { recursive: true, force: true });
	}
}

/** Runs the fake with FAKE_GH_STATE set, without touching the test process environment. */
function defaultExecWithState(statePath: string, file: string, args: string[], input?: string) {
	const previous = process.env.FAKE_GH_STATE;
	process.env.FAKE_GH_STATE = statePath;
	try {
		return defaultExec(file, args, input);
	} finally {
		if (previous === undefined) delete process.env.FAKE_GH_STATE;
		else process.env.FAKE_GH_STATE = previous;
	}
}
