// Public forge types. Adapters (GitHub, Gitea) return these shapes and
// nothing transport-specific leaks through.

/**
 * Opaque concurrency token. Callers only pass back the value they read.
 * Format depends on the adapter: `gh:<updatedAt>:<sha256>`, `cv:<n>`
 * (Gitea content_version) or `rc:<updatedAt>:<sha256>` (re-read check).
 */
export type Version = string & { __brand: "Version" };

export type ForgeKind = "github" | "gitea";

export type IssueState = "open" | "closed";

export interface Issue {
	number: number;
	title: string;
	body: string;
	labels: string[];
	state: IssueState;
	author: string;
	updatedAt: string;
	version: Version;
	/** Set by CachedForge when the value comes from cache during read-only mode. */
	stale?: boolean;
}

export interface IssueQuery {
	labels?: string[];
	state?: IssueState | "all";
	text?: string;
}

export interface Comment {
	id: string;
	author: string;
	body: string;
	createdAt: string;
	updatedAt: string;
	version: Version;
}

export type PullRequestState = "open" | "closed";

export interface PullRequest {
	number: number;
	state: PullRequestState;
	merged: boolean;
	mergedAt?: string;
	head: string;
	base: string;
	title: string;
	body: string;
	version: Version;
}

export type ReviewState = "approved" | "changes_requested" | "commented";

export interface Review {
	author: string;
	state: ReviewState;
	body: string;
}

export interface ReviewComment {
	path: string;
	line: number;
	body: string;
	author: string;
}

export type CheckState = "success" | "failure" | "pending" | "none";

export interface Check {
	name: string;
	state: CheckState;
	url?: string;
}

export interface CheckSummary {
	state: CheckState;
	checks: Check[];
}

/**
 * `written`: the body was sent. `check` says how strong the concurrency
 * check was: `strict` means the forge enforced it, `best-effort` means a
 * re-read and compare only.
 * `conflict`: nothing was written; `changed` names what differs from the
 * caller's version.
 */
export type WriteResult =
	| { status: "written"; issue: Issue; check: "strict" | "best-effort" }
	| { status: "conflict"; current: Version; changed: string[] };

/**
 * Forge operations. Every issue, pull request and comment carries a
 * `version`. Writes that take `expect` return a WriteResult instead of
 * throwing on conflict; transport, auth and HTTP failures throw ForgeError.
 */
export interface Forge {
	readonly kind: ForgeKind;

	whoami(): Promise<{ login: string }>;

	getIssue(n: number): Promise<Issue>;
	searchIssues(q: IssueQuery): Promise<Issue[]>;
	getPermission(login: string): Promise<"none" | "read" | "write" | "admin">;
	createIssue(i: { title: string; body: string; labels: string[] }): Promise<Issue>;
	updateIssueBody(n: number, body: string, expect: Version): Promise<WriteResult>;
	closeIssue(n: number): Promise<void>;
	reopenIssue(n: number): Promise<void>;
	addLabels(n: number, labels: string[]): Promise<void>;
	removeLabels(n: number, labels: string[]): Promise<void>;

	listComments(n: number): Promise<Comment[]>;
	createComment(n: number, body: string): Promise<Comment>;
	updateComment(id: string, body: string, expect: Version): Promise<WriteResult>;

	findOpenPullRequest(head: string): Promise<PullRequest | null>;
	getPullRequest(n: number): Promise<PullRequest>;
	listPullRequests(q: { state: "open" | "closed" | "all"; head?: string }): Promise<PullRequest[]>;
	getPullRequestFiles(pr: number): Promise<string[]>;
	listReviews(pr: number): Promise<Review[]>;
	createPullRequest(p: { head: string; base: string; title: string; body: string }): Promise<PullRequest>;
	updatePullRequest(n: number, p: { title?: string; body?: string }, expect: Version): Promise<WriteResult>;
	listReviewComments(pr: number): Promise<ReviewComment[]>;
	createReviewComment(pr: number, c: { path: string; line: number; body: string }): Promise<void>;

	getChecks(ref: string): Promise<CheckSummary>;
}
