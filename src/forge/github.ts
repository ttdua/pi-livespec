// GitHub adapter. Talks to the forge only through `gh api` with JSON output.
// GitHub has no conditional write, so body edits re-read, compare and then
// PATCH (see design.md); such writes report `check: "best-effort"`.

import { execFile } from "node:child_process";
import { ForgeError, type ForgeErrorCode } from "./errors.ts";
import { parseMarked } from "./markers.ts";
import { ensureLabels, type LabelRepo } from "./labels.ts";
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
	ReviewState,
	Version,
	WriteResult,
} from "./types.ts";
import { type SnapshotKind, SnapshotStore } from "./snapshots.ts";
import { bodyVersion, type ComparableIssue, changedFields } from "./version.ts";

export interface ExecResult {
	stdout: string;
	stderr: string;
	/** Exit code; `null` when the process could not be started. */
	code: number | null;
	/** Set when the process could not be started (for example, `gh` is not installed). */
	spawnError?: string;
}

/** Runs a program. Resolves also on non-zero exit; never rejects. */
export type ExecFn = (file: string, args: string[], input?: string) => Promise<ExecResult>;

export interface GitHubForgeOptions {
	/** Path of the `gh` executable. */
	ghPath: string;
	repo: { owner: string; repo: string };
	exec?: ExecFn;
}

export const defaultExec: ExecFn = (file, args, input) =>
	new Promise((resolve) => {
		const child = execFile(file, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error && typeof error.code !== "number") {
				resolve({ stdout, stderr, code: null, spawnError: error.message });
				return;
			}
			resolve({ stdout, stderr, code: error ? (error.code as number) : 0 });
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(input);
	});

interface ApiCall {
	method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	body?: Record<string, unknown>;
	/** Follow pagination and merge the pages into one array. */
	paginate?: boolean;
	/** With `paginate`: return the pages as they are instead of concatenating arrays (object responses). */
	pages?: boolean;
}

interface JsonUser {
	login: string;
}
interface JsonLabel {
	name: string;
}
interface JsonIssue {
	number: number;
	title: string;
	body: string | null;
	labels: JsonLabel[];
	state: "open" | "closed";
	user: JsonUser | null;
	updated_at: string;
	pull_request?: unknown;
}
interface JsonComment {
	id: number;
	user: JsonUser | null;
	body: string | null;
	created_at: string;
	updated_at: string;
}
interface JsonPull {
	number: number;
	state: "open" | "closed";
	merged?: boolean;
	merged_at: string | null;
	head: { ref: string; sha: string };
	base: { ref: string };
	title: string;
	body: string | null;
	updated_at: string;
}
interface JsonReview {
	user: JsonUser | null;
	state: string;
	body: string | null;
}
interface JsonReviewComment {
	path: string;
	line: number | null;
	body: string;
	user: JsonUser | null;
}
interface JsonCheckRun {
	name: string;
	status: string;
	conclusion: string | null;
	details_url: string | null;
}
interface JsonStatus {
	context: string;
	state: string;
	target_url: string | null;
}

const HTTP_STATUS = /\(HTTP (\d{3})\)/;

export class GitHubForge implements Forge, LabelRepo {
	readonly kind = "github" as const;

	private readonly ghPath: string;
	private readonly exec: ExecFn;
	private readonly base: string;
	private authenticated = false;
	/** What each version this adapter handed out looked like, to name changed fields on conflict. */
	private readonly snapshots = new SnapshotStore();

	constructor(opts: GitHubForgeOptions) {
		this.ghPath = opts.ghPath;
		this.exec = opts.exec ?? defaultExec;
		this.base = `repos/${opts.repo.owner}/${opts.repo.repo}`;
	}

	// --- identity ---------------------------------------------------------

	async whoami(): Promise<{ login: string }> {
		const user = await this.api<JsonUser>("whoami", "user");
		return { login: user.login };
	}

	async getPermission(login: string): Promise<"none" | "read" | "write" | "admin"> {
		const res = await this.api<{ permission: string }>("getPermission", `${this.base}/collaborators/${encodeURIComponent(login)}/permission`);
		switch (res.permission) {
			case "admin":
				return "admin";
			case "write":
			case "maintain":
				return "write";
			case "read":
			case "triage":
				return "read";
			default:
				return "none";
		}
	}

	// --- issues -----------------------------------------------------------

	async getIssue(n: number): Promise<Issue> {
		return this.toIssue(await this.api<JsonIssue>("getIssue", `${this.base}/issues/${n}`));
	}

	async searchIssues(q: IssueQuery): Promise<Issue[]> {
		const params = new URLSearchParams({ state: q.state ?? "open", per_page: "100" });
		if (q.labels?.length) params.set("labels", q.labels.join(","));
		const raw = await this.api<JsonIssue[]>("searchIssues", `${this.base}/issues?${params}`, { paginate: true });
		const needle = q.text?.toLowerCase();
		return raw
			.filter((i) => i.pull_request === undefined)
			.map((i) => this.toIssue(i))
			.filter((i) => needle === undefined || `${i.title}\n${i.body}`.toLowerCase().includes(needle));
	}

	async createIssue(i: { title: string; body: string; labels: string[] }): Promise<Issue> {
		await ensureLabels(this, i.labels);
		const raw = await this.api<JsonIssue>("createIssue", `${this.base}/issues`, { method: "POST", body: i });
		return this.toIssue(raw);
	}

	async updateIssueBody(n: number, body: string, expect: Version): Promise<WriteResult<Issue>> {
		const route = `${this.base}/issues/${n}`;
		const current = this.toIssue(await this.api<JsonIssue>("updateIssueBody", route));
		if (current.version !== expect) {
			return this.conflict("issue", n, expect, current.version, current);
		}
		const raw = await this.api<JsonIssue>("updateIssueBody", route, { method: "PATCH", body: { body } });
		return { status: "written", item: this.toIssue(raw), check: "best-effort" };
	}

	async closeIssue(n: number): Promise<void> {
		await this.api("closeIssue", `${this.base}/issues/${n}`, { method: "PATCH", body: { state: "closed" } });
	}

	async reopenIssue(n: number): Promise<void> {
		await this.api("reopenIssue", `${this.base}/issues/${n}`, { method: "PATCH", body: { state: "open" } });
	}

	async addLabels(n: number, labels: string[]): Promise<void> {
		await ensureLabels(this, labels);
		await this.api("addLabels", `${this.base}/issues/${n}/labels`, { method: "POST", body: { labels } });
	}

	async removeLabels(n: number, labels: string[]): Promise<void> {
		for (const label of labels) {
			try {
				await this.api("removeLabels", `${this.base}/issues/${n}/labels/${encodeURIComponent(label)}`, { method: "DELETE" });
			} catch (error) {
				// A label that is not on the issue is already removed.
				if (!(error instanceof ForgeError && error.code === "http" && error.status === 404)) throw error;
			}
		}
	}

	// --- label repository (internal) ---------------------------------------

	async listLabels(): Promise<string[]> {
		const raw = await this.api<JsonLabel[]>("listLabels", `${this.base}/labels?per_page=100`, { paginate: true });
		return raw.map((l) => l.name);
	}

	async createLabel(name: string): Promise<void> {
		await this.api("createLabel", `${this.base}/labels`, { method: "POST", body: { name } });
	}

	// --- comments ---------------------------------------------------------

	async listComments(n: number): Promise<Comment[]> {
		const raw = await this.api<JsonComment[]>("listComments", `${this.base}/issues/${n}/comments?per_page=100`, { paginate: true });
		return raw.map(toComment);
	}

	async createComment(n: number, body: string): Promise<Comment> {
		return toComment(await this.api<JsonComment>("createComment", `${this.base}/issues/${n}/comments`, { method: "POST", body: { body } }));
	}

	/**
	 * Refuses unless the stored comment is a marked comment of the current login.
	 * Last write wins: GitHub offers no check for comments, so `expect` is not compared.
	 */
	async updateComment(id: string, body: string, _expect: Version): Promise<WriteResult<Comment>> {
		const route = `${this.base}/issues/comments/${id}`;
		const stored = await this.api<JsonComment>("updateComment", route);
		const { login } = await this.whoami();
		if (!parseMarked(stored.body ?? "") || stored.user?.login !== login) {
			throw fail("unsupported", "updateComment", `refusing to edit comment ${id}: not a marked comment written by ${login}`);
		}
		const raw = await this.api<JsonComment>("updateComment", route, { method: "PATCH", body: { body } });
		return { status: "written", item: toComment(raw), check: "best-effort" };
	}

	// --- pull requests ----------------------------------------------------

	async findOpenPullRequest(head: string): Promise<PullRequest | null> {
		const [first] = await this.listPullRequests({ state: "open", head });
		return first ?? null;
	}

	async getPullRequest(n: number): Promise<PullRequest> {
		return this.toPull(await this.api<JsonPull>("getPullRequest", `${this.base}/pulls/${n}`));
	}

	async listPullRequests(q: { state: "open" | "closed" | "all"; head?: string }): Promise<PullRequest[]> {
		const params = new URLSearchParams({ state: q.state, per_page: "100" });
		if (q.head !== undefined) params.set("head", q.head.includes(":") ? q.head : `${this.owner()}:${q.head}`);
		const raw = await this.api<JsonPull[]>("listPullRequests", `${this.base}/pulls?${params}`, { paginate: true });
		return raw.map((p) => this.toPull(p));
	}

	async getPullRequestFiles(pr: number): Promise<string[]> {
		const raw = await this.api<{ filename: string }[]>("getPullRequestFiles", `${this.base}/pulls/${pr}/files?per_page=100`, { paginate: true });
		return raw.map((f) => f.filename);
	}

	async listReviews(pr: number): Promise<Review[]> {
		const raw = await this.api<JsonReview[]>("listReviews", `${this.base}/pulls/${pr}/reviews?per_page=100`, { paginate: true });
		return raw.map((r) => ({ author: r.user?.login ?? "", state: toReviewState(r.state), body: r.body ?? "" }));
	}

	async createPullRequest(p: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
		return this.toPull(await this.api<JsonPull>("createPullRequest", `${this.base}/pulls`, { method: "POST", body: p }));
	}

	async updatePullRequest(n: number, p: { title?: string; body?: string }, expect: Version): Promise<WriteResult<PullRequest>> {
		const route = `${this.base}/pulls/${n}`;
		const current = this.toPull(await this.api<JsonPull>("updatePullRequest", route));
		if (current.version !== expect) {
			return this.conflict("pull", n, expect, current.version, { title: current.title, body: current.body, labels: [], state: current.state });
		}
		const raw = await this.api<JsonPull>("updatePullRequest", route, { method: "PATCH", body: p });
		return { status: "written", item: this.toPull(raw), check: "best-effort" };
	}

	async listReviewComments(pr: number): Promise<ReviewComment[]> {
		const raw = await this.api<JsonReviewComment[]>("listReviewComments", `${this.base}/pulls/${pr}/comments?per_page=100`, { paginate: true });
		return raw.map((c) => ({ path: c.path, line: c.line ?? 0, body: c.body, author: c.user?.login ?? "" }));
	}

	async createReviewComment(pr: number, c: { path: string; line: number; body: string }): Promise<void> {
		const pull = await this.api<JsonPull>("createReviewComment", `${this.base}/pulls/${pr}`);
		await this.api("createReviewComment", `${this.base}/pulls/${pr}/comments`, {
			method: "POST",
			body: { body: c.body, path: c.path, line: c.line, side: "RIGHT", commit_id: pull.head.sha },
		});
	}

	// --- checks -----------------------------------------------------------

	async getChecks(ref: string): Promise<CheckSummary> {
		const sha = encodeURIComponent(ref);
		const runPages = await this.api<{ check_runs: JsonCheckRun[] }[]>("getChecks", `${this.base}/commits/${sha}/check-runs?per_page=100`, {
			paginate: true,
			pages: true,
		});
		const statusPages = await this.api<{ statuses: JsonStatus[] }[]>("getChecks", `${this.base}/commits/${sha}/status?per_page=100`, {
			paginate: true,
			pages: true,
		});
		const checks: Check[] = [
			...runPages.flatMap((page) => page.check_runs.map((r) => withUrl({ name: r.name, state: runState(r) }, r.details_url))),
			...statusPages.flatMap((page) => page.statuses.map((s) => withUrl({ name: s.context, state: statusState(s.state) }, s.target_url))),
		];
		return { state: overallState(checks), checks };
	}

	// --- mapping ----------------------------------------------------------

	private owner(): string {
		return this.base.split("/")[1];
	}

	private toIssue(raw: JsonIssue): Issue {
		const body = raw.body ?? "";
		const issue: Issue = {
			number: raw.number,
			title: raw.title,
			body,
			labels: raw.labels.map((l) => l.name),
			state: raw.state,
			author: raw.user?.login ?? "",
			updatedAt: raw.updated_at,
			version: bodyVersion(raw.updated_at, body, "gh"),
		};
		this.snapshots.remember("issue", issue.number, issue.version, issue);
		return issue;
	}

	private toPull(raw: JsonPull): PullRequest {
		const body = raw.body ?? "";
		const pull: PullRequest = {
			number: raw.number,
			state: raw.state,
			merged: raw.merged ?? raw.merged_at !== null,
			head: raw.head.ref,
			base: raw.base.ref,
			title: raw.title,
			body,
			version: bodyVersion(raw.updated_at, body, "gh"),
		};
		if (raw.merged_at) pull.mergedAt = raw.merged_at;
		this.snapshots.remember("pull", pull.number, pull.version, { title: pull.title, body, labels: [], state: pull.state });
		return pull;
	}

	private conflict(
		kind: SnapshotKind,
		n: number,
		expected: Version,
		current: Version,
		now: ComparableIssue,
	): { status: "conflict"; current: Version; changed: string[] } {
		const before = this.snapshots.recall(kind, n, expected);
		const changed = before ? changedFields(before, now) : [];
		// A version mismatch with equal compared fields still means the item moved on.
		return { status: "conflict", current, changed: changed.length > 0 ? changed : ["body"] };
	}

	// --- transport --------------------------------------------------------

	/** `gh auth status`, once per adapter after it has succeeded. */
	private async ensureAuth(operation: string): Promise<void> {
		if (this.authenticated) return;
		const res = await this.run(["auth", "status"]);
		if (res.spawnError !== undefined) throw fail("unreachable", operation, `cannot run gh: ${res.spawnError}`);
		if (res.code !== 0) {
			const detail = res.stderr.trim() || res.stdout.trim();
			if (looksLikeNetworkError(detail)) throw fail("unreachable", operation, `${operation}: GitHub is unreachable: ${detail}`);
			throw fail("auth", operation, `${operation}: not authenticated with gh: ${detail}`);
		}
		this.authenticated = true;
	}

	private async api<T = unknown>(operation: string, route: string, call: ApiCall = {}): Promise<T> {
		await this.ensureAuth(operation);
		const method = call.method ?? "GET";
		const args = ["api", route, "--method", method];
		if (call.paginate) args.push("--paginate", "--slurp");
		const input = call.body === undefined ? undefined : JSON.stringify(call.body);
		if (input !== undefined) args.push("--input", "-");

		const res = await this.run(args, input);
		if (res.spawnError !== undefined) throw fail("unreachable", operation, `${operation}: cannot run gh: ${res.spawnError}`);
		if (res.code !== 0) throw this.failedCall(operation, res);
		return parseResponse<T>(operation, res.stdout, call.paginate === true, call.pages === true);
	}

	private failedCall(operation: string, res: ExecResult): ForgeError {
		const detail = res.stderr.trim() || res.stdout.trim();
		const status = Number(HTTP_STATUS.exec(detail)?.[1]);
		if (!status) return fail("unreachable", operation, `${operation}: GitHub is unreachable: ${detail}`);
		if (status === 401) return fail("auth", operation, `${operation}: GitHub rejected the credentials: ${detail}`, status);
		return fail("http", operation, `${operation}: ${detail}`, status);
	}

	private run(args: string[], input?: string): Promise<ExecResult> {
		return this.exec(this.ghPath, args, input);
	}
}

function fail(code: ForgeErrorCode, operation: string, message: string, status?: number): ForgeError {
	return new ForgeError({ code, operation, message, status });
}

function looksLikeNetworkError(detail: string): boolean {
	return /error connecting|dial tcp|timeout|timed out|no such host|connection refused|network/i.test(detail);
}

function parseResponse<T>(operation: string, stdout: string, paged: boolean, rawPages: boolean): T {
	if (stdout.trim() === "") return undefined as T;
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		throw fail("http", operation, `${operation}: gh returned invalid JSON`);
	}
	// `--paginate --slurp` yields an array of pages.
	return (paged && !rawPages ? (value as unknown[]).flat() : value) as T;
}

function toComment(raw: JsonComment): Comment {
	const body = raw.body ?? "";
	return {
		id: String(raw.id),
		author: raw.user?.login ?? "",
		body,
		createdAt: raw.created_at,
		updatedAt: raw.updated_at,
		version: bodyVersion(raw.updated_at, body, "gh"),
	};
}

function toReviewState(state: string): ReviewState {
	if (state === "APPROVED") return "approved";
	if (state === "CHANGES_REQUESTED") return "changes_requested";
	return "commented";
}

function withUrl(check: Check, url: string | null): Check {
	return url ? { ...check, url } : check;
}

function runState(run: JsonCheckRun): CheckState {
	if (run.status !== "completed") return "pending";
	switch (run.conclusion) {
		case "success":
		case "neutral":
		case "skipped":
			return "success";
		default:
			return "failure";
	}
}

function statusState(state: string): CheckState {
	if (state === "success") return "success";
	if (state === "failure" || state === "error") return "failure";
	return "pending";
}

function overallState(checks: Check[]): CheckState {
	if (checks.length === 0) return "none";
	if (checks.some((c) => c.state === "failure")) return "failure";
	if (checks.some((c) => c.state === "pending")) return "pending";
	return "success";
}
