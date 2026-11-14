// In-memory reference Forge plus world. It proves the contract suite is
// green against a backend that behaves per spec; adapters must match it.

import { ForgeError } from "../../src/forge/errors.ts";
import type {
	Check,
	CheckState,
	CheckSummary,
	Comment,
	Forge,
	Issue,
	IssueQuery,
	PullRequest,
	Review,
	ReviewComment,
	Version,
	WriteResult,
} from "../../src/forge/types.ts";
import { type ComparableIssue, changedFields } from "../../src/forge/version.ts";
import {
	BOT_LOGIN,
	type ContractWorld,
	OTHER_LOGIN,
	type SeedIssue,
	type SeedPullRequest,
	type SeedReview,
	type SeedStatus,
} from "./world.ts";

interface IssueRecord {
	number: number;
	title: string;
	body: string;
	labels: string[];
	state: "open" | "closed";
	author: string;
	updatedAt: string;
	rev: number;
}

interface CommentRecord {
	id: string;
	issue: number;
	author: string;
	body: string;
	createdAt: string;
	updatedAt: string;
	rev: number;
}

interface PullRecord {
	number: number;
	state: "open" | "closed";
	merged: boolean;
	head: string;
	base: string;
	title: string;
	body: string;
	files: string[];
	reviews: Review[];
	reviewComments: ReviewComment[];
	rev: number;
}

const toVersion = (rev: number): Version => `cv:${rev}` as Version;

export class MemoryWorld implements ContractWorld {
	readonly forge: Forge;
	private readonly state = new MemoryState();

	constructor() {
		this.forge = new MemoryForge(this.state);
	}

	async seedIssue(issue: SeedIssue = {}): Promise<number> {
		const s = this.state;
		const labels = issue.labels ?? [];
		for (const label of labels) s.labels.add(label);
		const number = s.nextNumber++;
		s.issues.set(number, {
			number,
			title: issue.title ?? `issue ${number}`,
			body: issue.body ?? "",
			labels: [...labels],
			state: issue.state ?? "open",
			author: issue.author ?? OTHER_LOGIN,
			updatedAt: s.tick(),
			rev: 1,
		});
		return number;
	}

	async editBodyBehindBack(n: number, body: string): Promise<void> {
		const issue = this.state.issue(n);
		issue.body = body;
		this.state.touch(issue);
	}

	async bodyOf(n: number): Promise<string> {
		return this.state.issue(n).body;
	}

	async postComment(n: number, author: string, body: string): Promise<string> {
		return this.state.addComment(n, author, body).id;
	}

	async commentBodyOf(id: string): Promise<string> {
		return this.state.comment(id).body;
	}

	async hasLabel(name: string): Promise<boolean> {
		return this.state.labels.has(name);
	}

	async dropLabel(name: string): Promise<void> {
		this.state.labels.delete(name);
		for (const issue of this.state.issues.values()) {
			issue.labels = issue.labels.filter((l) => l !== name);
		}
	}

	async labelCreateCount(name: string): Promise<number> {
		return this.state.labelCreates.get(name) ?? 0;
	}

	async seedPullRequest(pr: SeedPullRequest): Promise<number> {
		const s = this.state;
		const number = s.nextNumber++;
		s.pulls.set(number, {
			number,
			state: pr.state ?? "open",
			merged: pr.merged ?? false,
			head: pr.head,
			base: pr.base ?? "main",
			title: pr.title ?? `pull ${number}`,
			body: pr.body ?? "",
			files: pr.files ?? [],
			reviews: [],
			reviewComments: [],
			rev: 1,
		});
		return number;
	}

	async editPullRequestBodyBehindBack(n: number, body: string): Promise<void> {
		const pull = this.state.pull(n);
		pull.body = body;
		pull.rev += 1;
	}

	async seedReview(pr: number, review: SeedReview): Promise<void> {
		this.state.pull(pr).reviews.push({ ...review });
	}

	async seedStatus(ref: string, status: SeedStatus): Promise<void> {
		const list = this.state.statuses.get(ref) ?? [];
		list.push({ ...status });
		this.state.statuses.set(ref, list);
	}

	async reviewCommentsOf(pr: number): Promise<ReviewComment[]> {
		return this.state.pull(pr).reviewComments.map((c) => ({ ...c }));
	}

	async makeUnreachable(): Promise<void> {
		this.state.unreachable = true;
	}

	async restore(): Promise<void> {
		this.state.unreachable = false;
	}
}

class MemoryState {
	readonly issues = new Map<number, IssueRecord>();
	readonly comments = new Map<string, CommentRecord>();
	readonly pulls = new Map<number, PullRecord>();
	readonly statuses = new Map<string, SeedStatus[]>();
	readonly labels = new Set<string>();
	readonly labelCreates = new Map<string, number>();
	/** Body/title/labels/state seen at each version, to name what changed on a stale write. */
	readonly snapshots = new Map<string, ComparableIssue>();
	unreachable = false;
	nextNumber = 1;
	private nextCommentId = 1;
	private clock = 0;

	tick(): string {
		this.clock += 1;
		return new Date(Date.UTC(2026, 0, 1, 0, 0, this.clock)).toISOString();
	}

	issue(n: number): IssueRecord {
		const found = this.issues.get(n);
		if (!found) throw new ForgeError({ code: "http", operation: "getIssue", message: `issue ${n} not found`, status: 404 });
		return found;
	}

	pull(n: number): PullRecord {
		const found = this.pulls.get(n);
		if (!found) throw new ForgeError({ code: "http", operation: "getPullRequest", message: `pull ${n} not found`, status: 404 });
		return found;
	}

	comment(id: string): CommentRecord {
		const found = this.comments.get(id);
		if (!found) throw new ForgeError({ code: "http", operation: "updateComment", message: `comment ${id} not found`, status: 404 });
		return found;
	}

	/** Records a write: new revision, new updatedAt. */
	touch(issue: IssueRecord): void {
		issue.rev += 1;
		issue.updatedAt = this.tick();
	}

	addComment(n: number, author: string, body: string): CommentRecord {
		this.issue(n);
		const now = this.tick();
		const record: CommentRecord = {
			id: String(this.nextCommentId++),
			issue: n,
			author,
			body,
			createdAt: now,
			updatedAt: now,
			rev: 1,
		};
		this.comments.set(record.id, record);
		return record;
	}

	ensureLabel(name: string): void {
		if (this.labels.has(name)) return;
		this.labels.add(name);
		this.labelCreates.set(name, (this.labelCreates.get(name) ?? 0) + 1);
	}
}

class MemoryForge implements Forge {
	readonly kind = "gitea";

	constructor(private readonly s: MemoryState) {}

	private guard(operation: string): void {
		if (this.s.unreachable) {
			throw new ForgeError({ code: "unreachable", operation, message: `${operation}: connection refused` });
		}
	}

	async whoami(): Promise<{ login: string }> {
		this.guard("whoami");
		return { login: BOT_LOGIN };
	}

	async getIssue(n: number): Promise<Issue> {
		this.guard("getIssue");
		return this.view(this.s.issue(n));
	}

	async searchIssues(q: IssueQuery): Promise<Issue[]> {
		this.guard("searchIssues");
		const state = q.state ?? "open";
		const text = q.text?.toLowerCase();
		return [...this.s.issues.values()]
			.filter((i) => state === "all" || i.state === state)
			.filter((i) => (q.labels ?? []).every((l) => i.labels.includes(l)))
			.filter((i) => !text || `${i.title}\n${i.body}`.toLowerCase().includes(text))
			.map((i) => this.view(i));
	}

	async getPermission(): Promise<"none" | "read" | "write" | "admin"> {
		this.guard("getPermission");
		return "admin";
	}

	async createIssue(i: { title: string; body: string; labels: string[] }): Promise<Issue> {
		this.guard("createIssue");
		for (const label of i.labels) this.s.ensureLabel(label);
		const number = this.s.nextNumber++;
		const record: IssueRecord = {
			number,
			title: i.title,
			body: i.body,
			labels: [...i.labels],
			state: "open",
			author: BOT_LOGIN,
			updatedAt: this.s.tick(),
			rev: 1,
		};
		this.s.issues.set(number, record);
		return this.view(record);
	}

	async updateIssueBody(n: number, body: string, expect: Version): Promise<WriteResult> {
		this.guard("updateIssueBody");
		const issue = this.s.issue(n);
		const current = toVersion(issue.rev);
		if (current !== expect) {
			return { status: "conflict", current, changed: this.changedSince(`issue:${n}:${expect}`, issue) };
		}
		issue.body = body;
		this.s.touch(issue);
		return { status: "written", issue: this.view(issue), check: "strict" };
	}

	async closeIssue(n: number): Promise<void> {
		this.guard("closeIssue");
		const issue = this.s.issue(n);
		issue.state = "closed";
		this.s.touch(issue);
	}

	async reopenIssue(n: number): Promise<void> {
		this.guard("reopenIssue");
		const issue = this.s.issue(n);
		issue.state = "open";
		this.s.touch(issue);
	}

	async addLabels(n: number, labels: string[]): Promise<void> {
		this.guard("addLabels");
		const issue = this.s.issue(n);
		for (const label of labels) {
			this.s.ensureLabel(label);
			if (!issue.labels.includes(label)) issue.labels.push(label);
		}
		this.s.touch(issue);
	}

	async removeLabels(n: number, labels: string[]): Promise<void> {
		this.guard("removeLabels");
		const issue = this.s.issue(n);
		issue.labels = issue.labels.filter((l) => !labels.includes(l));
		this.s.touch(issue);
	}

	async listComments(n: number): Promise<Comment[]> {
		this.guard("listComments");
		this.s.issue(n);
		return [...this.s.comments.values()].filter((c) => c.issue === n).map(commentView);
	}

	async createComment(n: number, body: string): Promise<Comment> {
		this.guard("createComment");
		return commentView(this.s.addComment(n, BOT_LOGIN, body));
	}

	/** Comment edits are last-write-wins: `expect` is not enforced. */
	async updateComment(id: string, body: string, _expect: Version): Promise<WriteResult> {
		this.guard("updateComment");
		const comment = this.s.comment(id);
		comment.body = body;
		comment.rev += 1;
		comment.updatedAt = this.s.tick();
		return { status: "written", issue: this.view(this.s.issue(comment.issue)), check: "best-effort" };
	}

	async findOpenPullRequest(head: string): Promise<PullRequest | null> {
		this.guard("findOpenPullRequest");
		const found = [...this.s.pulls.values()].find((p) => p.state === "open" && p.head === head);
		return found ? this.pullView(found) : null;
	}

	async getPullRequest(n: number): Promise<PullRequest> {
		this.guard("getPullRequest");
		return this.pullView(this.s.pull(n));
	}

	async listPullRequests(q: { state: "open" | "closed" | "all"; head?: string }): Promise<PullRequest[]> {
		this.guard("listPullRequests");
		return [...this.s.pulls.values()]
			.filter((p) => q.state === "all" || p.state === q.state)
			.filter((p) => q.head === undefined || p.head === q.head)
			.map((p) => this.pullView(p));
	}

	async getPullRequestFiles(pr: number): Promise<string[]> {
		this.guard("getPullRequestFiles");
		return [...this.s.pull(pr).files];
	}

	async listReviews(pr: number): Promise<Review[]> {
		this.guard("listReviews");
		return this.s.pull(pr).reviews.map((r) => ({ ...r }));
	}

	async createPullRequest(p: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
		this.guard("createPullRequest");
		const number = this.s.nextNumber++;
		const record: PullRecord = { number, state: "open", merged: false, ...p, files: [], reviews: [], reviewComments: [], rev: 1 };
		this.s.pulls.set(number, record);
		return this.pullView(record);
	}

	async updatePullRequest(n: number, p: { title?: string; body?: string }, expect: Version): Promise<WriteResult> {
		this.guard("updatePullRequest");
		const pull = this.s.pull(n);
		const current = toVersion(pull.rev);
		if (current !== expect) {
			return { status: "conflict", current, changed: this.changedSince(`pull:${n}:${expect}`, pullComparable(pull)) };
		}
		if (p.title !== undefined) pull.title = p.title;
		if (p.body !== undefined) pull.body = p.body;
		pull.rev += 1;
		return { status: "written", issue: pullAsIssue(pull), check: "strict" };
	}

	async listReviewComments(pr: number): Promise<ReviewComment[]> {
		this.guard("listReviewComments");
		return this.s.pull(pr).reviewComments.map((c) => ({ ...c }));
	}

	async createReviewComment(pr: number, c: { path: string; line: number; body: string }): Promise<void> {
		this.guard("createReviewComment");
		this.s.pull(pr).reviewComments.push({ ...c, author: BOT_LOGIN });
	}

	async getChecks(ref: string): Promise<CheckSummary> {
		this.guard("getChecks");
		const checks: Check[] = (this.s.statuses.get(ref) ?? []).map((st) => ({
			name: st.name,
			state: st.state,
			...(st.url ? { url: st.url } : {}),
		}));
		return { state: overall(checks.map((c) => c.state)), checks };
	}

	private pullView(p: PullRecord): PullRequest {
		const version = toVersion(p.rev);
		this.s.snapshots.set(`pull:${p.number}:${version}`, pullComparable(p));
		return {
			number: p.number,
			state: p.state,
			merged: p.merged,
			head: p.head,
			base: p.base,
			title: p.title,
			body: p.body,
			version,
		};
	}

	private view(issue: IssueRecord): Issue {
		const version = toVersion(issue.rev);
		this.s.snapshots.set(`issue:${issue.number}:${version}`, comparable(issue));
		return {
			number: issue.number,
			title: issue.title,
			body: issue.body,
			labels: [...issue.labels],
			state: issue.state,
			author: issue.author,
			updatedAt: issue.updatedAt,
			version,
		};
	}

	/** Names the fields that differ between the version the caller read and the live item. */
	private changedSince(key: string, live: ComparableIssue): string[] {
		const old = this.s.snapshots.get(key);
		if (!old) return ["body"];
		const changed = changedFields(old, comparable(live));
		return changed.length > 0 ? changed : ["body"];
	}
}

const comparable = (i: ComparableIssue): ComparableIssue => ({
	title: i.title,
	body: i.body,
	labels: [...i.labels],
	state: i.state,
});

const pullComparable = (p: PullRecord): ComparableIssue => ({ title: p.title, body: p.body, labels: [], state: p.state });

function commentView(c: CommentRecord): Comment {
	return {
		id: c.id,
		author: c.author,
		body: c.body,
		createdAt: c.createdAt,
		updatedAt: c.updatedAt,
		version: toVersion(c.rev),
	};
}

/** `WriteResult.written` carries an `Issue`, so a pull request edit is reported in that shape. */
function pullAsIssue(p: PullRecord): Issue {
	return {
		number: p.number,
		title: p.title,
		body: p.body,
		labels: [],
		state: p.state,
		author: BOT_LOGIN,
		updatedAt: "",
		version: toVersion(p.rev),
	};
}

function overall(states: CheckState[]): CheckState {
	if (states.length === 0) return "none";
	if (states.includes("failure")) return "failure";
	if (states.includes("pending")) return "pending";
	return "success";
}
