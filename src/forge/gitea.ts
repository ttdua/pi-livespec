// Gitea adapter over `/api/v1` with Node's built-in fetch. Issue and pull
// request body edits use `content_version` when the server sends it (strict
// check); otherwise they fall back to a re-read and compare (best-effort).

import {
	type CommentDto,
	type Guard,
	type IssueDto,
	type PullDto,
	type StatusDto,
	isCombinedStatusDto,
	isCommentDto,
	isFileDto,
	isIssueDto,
	isLabelDto,
	isPermissionDto,
	isPullDto,
	isReviewCommentDto,
	isReviewDto,
	isStatusDto,
	isUserDto,
	shapeError,
} from "./gitea-dto.ts";
import { GiteaTransport, PAGE_SIZE } from "./gitea-transport.ts";
import { ensureLabels, type LabelRepo } from "./labels.ts";
import { assertOwnMarkedComment } from "./markers.ts";
import { overallState, toCheckState, toPermission, toReviewState } from "./mapping.ts";
import type {
	Check,
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
} from "./types.ts";
import { type SnapshotKind, SnapshotStore } from "./snapshots.ts";
import { bodyVersion, type ComparableIssue, changedFields } from "./version.ts";

export interface GiteaOptions {
	/** Server root, e.g. `https://gitea.example.org` (no `/api/v1`). */
	baseUrl: string;
	owner: string;
	repo: string;
	fetch?: typeof fetch;
	env?: Record<string, string | undefined>;
	/** Path of the `tea` config; when omitted, tea's own lookup order is followed. */
	teaConfigPath?: string;
	/** Test seams for the default `tea` config lookup. */
	homedir?: string;
	platform?: NodeJS.Platform;
	/** Limit for one HTTP request, response body included; default 30 000 ms. */
	timeoutMs?: number;
}

const DEFAULT_LABEL_COLOR = "ededed";
const CONTENT_VERSION_PREFIX = "cv:";

export class GiteaForge implements Forge, LabelRepo {
	readonly kind = "gitea";
	private readonly http: GiteaTransport;
	private readonly repoPath: string;
	/** What each version this adapter handed out looked like, to name changed fields on conflict. */
	private readonly snapshots = new SnapshotStore();

	constructor(opts: GiteaOptions) {
		this.http = new GiteaTransport(opts);
		this.repoPath = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`;
	}

	async whoami(): Promise<{ login: string }> {
		const user = await this.http.object("whoami", "GET", "/user", isUserDto);
		return { login: String(user.login) };
	}

	// ---- issues ----

	async getIssue(n: number): Promise<Issue> {
		return this.readIssue("getIssue", n);
	}

	async searchIssues(q: IssueQuery): Promise<Issue[]> {
		const params = new URLSearchParams({ type: "issues", state: q.state ?? "open" });
		if (q.labels?.length) params.set("labels", q.labels.join(","));
		if (q.text) params.set("q", q.text);
		const items = await this.http.list("searchIssues", `${this.repoPath}/issues?${params}`, isIssueDto);
		return items.map((json) => this.issueOf(json));
	}

	async getPermission(login: string): Promise<"none" | "read" | "write" | "admin"> {
		const json = await this.http.object("getPermission", "GET", `${this.repoPath}/collaborators/${encodeURIComponent(login)}/permission`, isPermissionDto);
		return toPermission(json.permission);
	}

	async createIssue(i: { title: string; body: string; labels: string[] }): Promise<Issue> {
		const json = await this.http.object("createIssue", "POST", `${this.repoPath}/issues`, isIssueDto, { title: i.title, body: i.body });
		const number = Number(json.number);
		if (i.labels.length === 0) return this.issueOf(json);
		await this.applyLabels("createIssue", number, i.labels);
		return this.readIssue("createIssue", number);
	}

	async updateIssueBody(n: number, body: string, expect: Version): Promise<WriteResult<Issue>> {
		return this.writeVersioned({
			operation: "updateIssueBody",
			kind: "issue",
			n,
			path: `${this.repoPath}/issues/${n}`,
			patch: { body },
			expect,
			read: () => this.readIssue("updateIssueBody", n),
			parse: (json) => this.issueOf(json),
			guard: isIssueDto,
		});
	}

	async closeIssue(n: number): Promise<void> {
		await this.http.call("closeIssue", "PATCH", `${this.repoPath}/issues/${n}`, { state: "closed" });
	}

	async reopenIssue(n: number): Promise<void> {
		await this.http.call("reopenIssue", "PATCH", `${this.repoPath}/issues/${n}`, { state: "open" });
	}

	// ---- labels ----

	async addLabels(n: number, labels: string[]): Promise<void> {
		await this.applyLabels("addLabels", n, labels);
	}

	async removeLabels(n: number, labels: string[]): Promise<void> {
		const issue = await this.http.object("removeLabels", "GET", `${this.repoPath}/issues/${n}`, isIssueDto);
		const ids = (issue.labels ?? []).filter((l) => labels.includes(String(l.name))).map((l) => Number(l.id));
		for (const id of ids) {
			await this.http.call("removeLabels", "DELETE", `${this.repoPath}/issues/${n}/labels/${id}`);
		}
	}

	async listLabels(): Promise<string[]> {
		const items = await this.http.list("listLabels", `${this.repoPath}/labels`, isLabelDto);
		return items.map((l) => String(l.name));
	}

	async createLabel(name: string): Promise<void> {
		await this.http.call("createLabel", "POST", `${this.repoPath}/labels`, { name, color: DEFAULT_LABEL_COLOR });
	}

	// ---- comments ----

	async listComments(n: number): Promise<Comment[]> {
		const items = await this.http.list("listComments", `${this.repoPath}/issues/${n}/comments`, isCommentDto);
		return items.map(toComment);
	}

	async createComment(n: number, body: string): Promise<Comment> {
		const json = await this.http.object("createComment", "POST", `${this.repoPath}/issues/${n}/comments`, isCommentDto, { body });
		return toComment(json);
	}

	/**
	 * Only a marked comment written by the current account may be edited: the
	 * comment is re-read and refused (no PATCH) otherwise. Gitea comments carry
	 * no version, so the edit is last-write-wins and `expect` is not checked.
	 */
	async updateComment(id: string, body: string, _expect: Version): Promise<WriteResult<Comment>> {
		const current = toComment(await this.http.object("updateComment", "GET", `${this.repoPath}/issues/comments/${encodeURIComponent(id)}`, isCommentDto));
		await assertOwnMarkedComment(this, current);
		const json = await this.http.object("updateComment", "PATCH", `${this.repoPath}/issues/comments/${encodeURIComponent(id)}`, isCommentDto, { body });
		return { status: "written", item: toComment(json), check: "best-effort" };
	}

	// ---- pull requests ----

	async findOpenPullRequest(head: string): Promise<PullRequest | null> {
		const [found] = await this.queryPullRequests("findOpenPullRequest", { state: "open", head });
		return found ?? null;
	}

	async getPullRequest(n: number): Promise<PullRequest> {
		return this.readPull("getPullRequest", n);
	}

	async listPullRequests(q: { state: "open" | "closed" | "all"; head?: string }): Promise<PullRequest[]> {
		return this.queryPullRequests("listPullRequests", q);
	}

	private async queryPullRequests(operation: string, q: { state: "open" | "closed" | "all"; head?: string }): Promise<PullRequest[]> {
		const items = await this.http.list(operation, `${this.repoPath}/pulls?state=${q.state}`, isPullDto);
		return items.map((json) => this.pullOf(json)).filter((p) => q.head === undefined || p.head === q.head);
	}

	async getPullRequestFiles(pr: number): Promise<string[]> {
		const items = await this.http.list("getPullRequestFiles", `${this.repoPath}/pulls/${pr}/files`, isFileDto);
		return items.map((f) => String(f.filename));
	}

	async listReviews(pr: number): Promise<Review[]> {
		const items = await this.http.list("listReviews", `${this.repoPath}/pulls/${pr}/reviews`, isReviewDto);
		return items.map((r) => ({ author: String(r.user?.login ?? ""), state: toReviewState(r.state), body: String(r.body ?? "") }));
	}

	async createPullRequest(p: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
		const json = await this.http.object("createPullRequest", "POST", `${this.repoPath}/pulls`, isPullDto, p);
		return this.pullOf(json);
	}

	async updatePullRequest(n: number, p: { title?: string; body?: string }, expect: Version): Promise<WriteResult<PullRequest>> {
		return this.writeVersioned({
			operation: "updatePullRequest",
			kind: "pull",
			n,
			path: `${this.repoPath}/pulls/${n}`,
			patch: p,
			expect,
			read: () => this.readPull("updatePullRequest", n),
			parse: (json) => this.pullOf(json),
			guard: isPullDto,
		});
	}

	async listReviewComments(pr: number): Promise<ReviewComment[]> {
		const reviews = await this.http.list("listReviewComments", `${this.repoPath}/pulls/${pr}/reviews`, isReviewDto);
		const result: ReviewComment[] = [];
		for (const review of reviews) {
			// Not paginated by Gitea: one GET returns them all.
			const items = await this.http.getArray("listReviewComments", `${this.repoPath}/pulls/${pr}/reviews/${review.id}/comments`, isReviewCommentDto);
			for (const c of items) {
				result.push({ path: String(c.path), line: Number(c.line ?? c.position ?? 0), body: String(c.body), author: String(c.user?.login ?? "") });
			}
		}
		return result;
	}

	async createReviewComment(pr: number, c: { path: string; line: number; body: string }): Promise<void> {
		await this.http.call("createReviewComment", "POST", `${this.repoPath}/pulls/${pr}/reviews`, {
			event: "COMMENT",
			body: "",
			comments: [{ path: c.path, body: c.body, new_position: c.line }],
		});
	}

	// ---- checks ----

	async getChecks(ref: string): Promise<CheckSummary> {
		const statuses = await this.statusPages(ref);
		const checks: Check[] = statuses.map((s) => ({
			name: String(s.context),
			state: toCheckState(s.status),
			...(s.target_url ? { url: String(s.target_url) } : {}),
		}));
		return { state: overallState(checks), checks };
	}

	/** The combined status is an object whose `statuses` is paginated. */
	private async statusPages(ref: string): Promise<StatusDto[]> {
		const path = `${this.repoPath}/commits/${encodeURIComponent(ref)}/status`;
		return this.http.pages("getChecks", async (page) => {
			const combined = await this.http.object("getChecks", "GET", `${path}?limit=${PAGE_SIZE}&page=${page}`, isCombinedStatusDto);
			const statuses = combined.statuses ?? [];
			if (!Array.isArray(statuses)) throw shapeError("getChecks", 200, "a statuses array");
			return statuses.map((entry) => {
				if (!isStatusDto(entry)) throw shapeError("getChecks", 200, "a list of well-formed statuses");
				return entry;
			});
		});
	}

	// ---- shared steps ----

	private async readIssue(operation: string, n: number): Promise<Issue> {
		return this.issueOf(await this.http.object(operation, "GET", `${this.repoPath}/issues/${n}`, isIssueDto));
	}

	private async readPull(operation: string, n: number): Promise<PullRequest> {
		return this.pullOf(await this.http.object(operation, "GET", `${this.repoPath}/pulls/${n}`, isPullDto));
	}

	private async applyLabels(operation: string, n: number, labels: string[]): Promise<void> {
		await ensureLabels(this, labels);
		await this.http.call(operation, "POST", `${this.repoPath}/issues/${n}/labels`, { labels });
	}

	/**
	 * Body write with a concurrency check. A `cv:` version is sent as
	 * `content_version` and a 409 is a conflict (strict). Any other version
	 * came from a server without `content_version`: re-read, compare, then
	 * write (best-effort). The write is never refused for the server version.
	 */
	private async writeVersioned<T extends Issue | PullRequest, D>(w: {
		operation: string;
		kind: SnapshotKind;
		n: number;
		path: string;
		patch: Record<string, unknown>;
		expect: Version;
		read: () => Promise<T>;
		parse: (json: D) => T;
		guard: Guard<D>;
	}): Promise<WriteResult<T>> {
		const strictVersion = contentVersionOf(w.expect);
		if (strictVersion !== undefined) {
			const reply = await this.http.call(w.operation, "PATCH", w.path, { ...w.patch, content_version: strictVersion }, [409]);
			if (reply.status === 409) return this.conflict(w.kind, w.n, w.expect, await w.read());
			return { status: "written", item: w.parse(this.http.asObject(w.operation, reply, w.guard)), check: "strict" };
		}

		const fresh = await w.read();
		if (fresh.version !== w.expect) return this.conflict(w.kind, w.n, w.expect, fresh);
		const reply = await this.http.call(w.operation, "PATCH", w.path, w.patch);
		return { status: "written", item: w.parse(this.http.asObject(w.operation, reply, w.guard)), check: "best-effort" };
	}

	/**
	 * Names the fields that differ between the snapshot of `expected` and the
	 * fresh read. An unknown snapshot, or a version change with equal compared
	 * fields, still conflicts and names `body`.
	 */
	private conflict<T extends Issue | PullRequest>(kind: SnapshotKind, n: number, expected: Version, fresh: T): WriteResult<T> {
		const before = this.snapshots.recall(kind, n, expected);
		const changed = before ? changedFields(before, comparableOf(fresh)) : [];
		return { status: "conflict", current: fresh.version, changed: changed.length > 0 ? changed : ["body"] };
	}

	// ---- mapping with snapshots ----

	private issueOf(json: IssueDto): Issue {
		const issue = toIssue(json);
		this.snapshots.remember("issue", issue.number, issue.version, comparableOf(issue));
		return issue;
	}

	private pullOf(json: PullDto): PullRequest {
		const pull = toPull(json);
		this.snapshots.remember("pull", pull.number, pull.version, comparableOf(pull));
		return pull;
	}
}

// ---- mapping ----

/** The compared fields of an issue or pull request; a pull request has no labels here, as in the GitHub adapter. */
function comparableOf(item: Issue | PullRequest): ComparableIssue {
	return { title: item.title, body: item.body, labels: "labels" in item ? item.labels : [], state: item.state };
}

function toVersion(json: IssueDto, body: string): Version {
	if (typeof json.content_version === "number") return `${CONTENT_VERSION_PREFIX}${json.content_version}` as Version;
	return bodyVersion(String(json.updated_at ?? ""), body, "rc");
}

function contentVersionOf(version: Version): number | undefined {
	if (!version.startsWith(CONTENT_VERSION_PREFIX)) return undefined;
	const n = Number(version.slice(CONTENT_VERSION_PREFIX.length));
	return Number.isInteger(n) ? n : undefined;
}

function toIssue(json: IssueDto): Issue {
	const body = String(json.body ?? "");
	return {
		number: Number(json.number),
		title: String(json.title ?? ""),
		body,
		labels: (json.labels ?? []).map((l) => String(l.name)),
		state: json.state === "closed" ? "closed" : "open",
		author: String(json.user?.login ?? ""),
		updatedAt: String(json.updated_at ?? ""),
		version: toVersion(json, body),
	};
}

function toComment(json: CommentDto): Comment {
	const body = String(json.body ?? "");
	return {
		id: String(json.id),
		author: String(json.user?.login ?? ""),
		body,
		createdAt: String(json.created_at ?? ""),
		updatedAt: String(json.updated_at ?? ""),
		version: bodyVersion(String(json.updated_at ?? ""), body, "rc"),
	};
}

function toPull(json: PullDto): PullRequest {
	const body = String(json.body ?? "");
	return {
		number: Number(json.number),
		state: json.state === "closed" ? "closed" : "open",
		merged: json.merged === true,
		...(json.merged_at ? { mergedAt: String(json.merged_at) } : {}),
		head: String(json.head?.ref ?? ""),
		base: String(json.base?.ref ?? ""),
		title: String(json.title ?? ""),
		body,
		version: toVersion(json, body),
	};
}
