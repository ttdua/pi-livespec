// Gitea adapter over `/api/v1` with Node's built-in fetch. Issue and pull
// request body edits use `content_version` when the server sends it (strict
// check); otherwise they fall back to a re-read and compare (best-effort).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ForgeError } from "./errors.ts";
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
import { bodyVersion } from "./version.ts";

export interface GiteaOptions {
	/** Server root, e.g. `https://gitea.example.org` (no `/api/v1`). */
	baseUrl: string;
	owner: string;
	repo: string;
	fetch?: typeof fetch;
	env?: Record<string, string | undefined>;
	/** Path of the `tea` config; defaults to `~/.config/tea/config.yml`. */
	teaConfigPath?: string;
}

const PAGE_SIZE = 50;
const DEFAULT_LABEL_COLOR = "ededed";
const CONTENT_VERSION_PREFIX = "cv:";

type Json = Record<string, any>;

interface Reply {
	status: number;
	json: any;
}

/** Authenticated JSON transport. Maps failures to ForgeError; callers pass `accept` for statuses they handle themselves. */
class GiteaTransport {
	private token?: string;
	private readonly fetchFn: typeof fetch;
	private readonly env: Record<string, string | undefined>;

	constructor(private readonly opts: GiteaOptions) {
		this.fetchFn = opts.fetch ?? fetch;
		this.env = opts.env ?? process.env;
	}

	async call(operation: string, method: string, path: string, body?: unknown, accept: number[] = []): Promise<Reply> {
		const token = await this.resolveToken(operation);
		let response: Response;
		try {
			response = await this.fetchFn(`${this.opts.baseUrl.replace(/\/+$/, "")}/api/v1${path}`, {
				method,
				headers: {
					authorization: `token ${token}`,
					accept: "application/json",
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (error) {
			throw new ForgeError({ code: "unreachable", operation, message: `${operation}: ${describe(error)}` });
		}
		const text = await response.text().catch(() => "");
		const json = parseJson(text);
		if (response.ok || accept.includes(response.status)) return { status: response.status, json };

		const detail = typeof json?.message === "string" ? json.message : text.slice(0, 200);
		const code = response.status === 401 || response.status === 403 ? "auth" : "http";
		throw new ForgeError({ code, operation, status: response.status, message: `${operation}: HTTP ${response.status} ${detail}`.trim() });
	}

	/** Reads every page of a list endpoint. */
	async list(operation: string, path: string): Promise<Json[]> {
		const all: Json[] = [];
		const sep = path.includes("?") ? "&" : "?";
		for (let page = 1; ; page++) {
			const { json } = await this.call(operation, "GET", `${path}${sep}limit=${PAGE_SIZE}&page=${page}`);
			const items = Array.isArray(json) ? (json as Json[]) : [];
			all.push(...items);
			if (items.length < PAGE_SIZE) return all;
		}
	}

	private async resolveToken(operation: string): Promise<string> {
		if (this.token) return this.token;
		const token = this.env.GITEA_TOKEN || (await this.tokenFromTeaConfig());
		if (!token) {
			throw new ForgeError({
				code: "auth",
				operation,
				message: `${operation}: no Gitea token; set GITEA_TOKEN or log in with tea for ${this.opts.baseUrl}`,
			});
		}
		this.token = token;
		return token;
	}

	/** Reads the token of the `tea` login whose url has the same host as `baseUrl`. Never runs `tea`. */
	private async tokenFromTeaConfig(): Promise<string | undefined> {
		const path = this.opts.teaConfigPath ?? join(homedir(), ".config", "tea", "config.yml");
		let config: unknown;
		try {
			config = parse(await readFile(path, "utf8"));
		} catch {
			return undefined;
		}
		const host = hostOf(this.opts.baseUrl);
		const logins = (config as { logins?: { url?: string; token?: string }[] } | null)?.logins;
		const login = Array.isArray(logins) ? logins.find((l) => l?.url && hostOf(l.url) === host && l.token) : undefined;
		return login?.token;
	}
}

export class GiteaForge implements Forge, LabelRepo {
	readonly kind = "gitea";
	private readonly http: GiteaTransport;
	private readonly repoPath: string;

	constructor(opts: GiteaOptions) {
		this.http = new GiteaTransport(opts);
		this.repoPath = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`;
	}

	async whoami(): Promise<{ login: string }> {
		const { json } = await this.http.call("whoami", "GET", "/user");
		return { login: String(json.login) };
	}

	// ---- issues ----

	async getIssue(n: number): Promise<Issue> {
		return this.readIssue("getIssue", n);
	}

	async searchIssues(q: IssueQuery): Promise<Issue[]> {
		const params = new URLSearchParams({ type: "issues", state: q.state ?? "open" });
		if (q.labels?.length) params.set("labels", q.labels.join(","));
		if (q.text) params.set("q", q.text);
		const items = await this.http.list("searchIssues", `${this.repoPath}/issues?${params}`);
		return items.map(toIssue);
	}

	async getPermission(login: string): Promise<"none" | "read" | "write" | "admin"> {
		const { json } = await this.http.call("getPermission", "GET", `${this.repoPath}/collaborators/${encodeURIComponent(login)}/permission`);
		return toPermission(json.permission);
	}

	async createIssue(i: { title: string; body: string; labels: string[] }): Promise<Issue> {
		const { json } = await this.http.call("createIssue", "POST", `${this.repoPath}/issues`, { title: i.title, body: i.body });
		const number = Number(json.number);
		if (i.labels.length === 0) return toIssue(json);
		await this.applyLabels("createIssue", number, i.labels);
		return this.readIssue("createIssue", number);
	}

	async updateIssueBody(n: number, body: string, expect: Version): Promise<WriteResult<Issue>> {
		return this.writeVersioned({
			operation: "updateIssueBody",
			path: `${this.repoPath}/issues/${n}`,
			patch: { body },
			expect,
			read: () => this.readIssue("updateIssueBody", n),
			parse: toIssue,
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
		const { json } = await this.http.call("removeLabels", "GET", `${this.repoPath}/issues/${n}`);
		const ids = (json.labels as Json[] | undefined ?? []).filter((l) => labels.includes(String(l.name))).map((l) => Number(l.id));
		for (const id of ids) {
			await this.http.call("removeLabels", "DELETE", `${this.repoPath}/issues/${n}/labels/${id}`);
		}
	}

	async listLabels(): Promise<string[]> {
		const items = await this.http.list("addLabels", `${this.repoPath}/labels`);
		return items.map((l) => String(l.name));
	}

	async createLabel(name: string): Promise<void> {
		await this.http.call("addLabels", "POST", `${this.repoPath}/labels`, { name, color: DEFAULT_LABEL_COLOR });
	}

	// ---- comments ----

	async listComments(n: number): Promise<Comment[]> {
		const items = await this.http.list("listComments", `${this.repoPath}/issues/${n}/comments`);
		return items.map(toComment);
	}

	async createComment(n: number, body: string): Promise<Comment> {
		const { json } = await this.http.call("createComment", "POST", `${this.repoPath}/issues/${n}/comments`, { body });
		return toComment(json);
	}

	/** Gitea comments carry no version, so the edit is last-write-wins and `expect` is not checked. */
	async updateComment(id: string, body: string, _expect: Version): Promise<WriteResult<Comment>> {
		const { json } = await this.http.call("updateComment", "PATCH", `${this.repoPath}/issues/comments/${encodeURIComponent(id)}`, { body });
		return { status: "written", item: toComment(json), check: "best-effort" };
	}

	// ---- pull requests ----

	async findOpenPullRequest(head: string): Promise<PullRequest | null> {
		const [found] = await this.listPullRequests({ state: "open", head }, "findOpenPullRequest");
		return found ?? null;
	}

	async getPullRequest(n: number): Promise<PullRequest> {
		return this.readPull("getPullRequest", n);
	}

	async listPullRequests(q: { state: "open" | "closed" | "all"; head?: string }, operation = "listPullRequests"): Promise<PullRequest[]> {
		const items = await this.http.list(operation, `${this.repoPath}/pulls?state=${q.state}`);
		return items.map(toPull).filter((p) => q.head === undefined || p.head === q.head);
	}

	async getPullRequestFiles(pr: number): Promise<string[]> {
		const items = await this.http.list("getPullRequestFiles", `${this.repoPath}/pulls/${pr}/files`);
		return items.map((f) => String(f.filename));
	}

	async listReviews(pr: number): Promise<Review[]> {
		const items = await this.http.list("listReviews", `${this.repoPath}/pulls/${pr}/reviews`);
		return items.map((r) => ({ author: String(r.user?.login ?? ""), state: toReviewState(r.state), body: String(r.body ?? "") }));
	}

	async createPullRequest(p: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
		const { json } = await this.http.call("createPullRequest", "POST", `${this.repoPath}/pulls`, p);
		return toPull(json);
	}

	async updatePullRequest(n: number, p: { title?: string; body?: string }, expect: Version): Promise<WriteResult<PullRequest>> {
		return this.writeVersioned({
			operation: "updatePullRequest",
			path: `${this.repoPath}/pulls/${n}`,
			patch: p,
			expect,
			read: () => this.readPull("updatePullRequest", n),
			parse: toPull,
		});
	}

	async listReviewComments(pr: number): Promise<ReviewComment[]> {
		const reviews = await this.http.list("listReviewComments", `${this.repoPath}/pulls/${pr}/reviews`);
		const result: ReviewComment[] = [];
		for (const review of reviews) {
			const items = await this.http.list("listReviewComments", `${this.repoPath}/pulls/${pr}/reviews/${review.id}/comments`);
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
		const { json } = await this.http.call("getChecks", "GET", `${this.repoPath}/commits/${encodeURIComponent(ref)}/status`);
		const checks: Check[] = ((json.statuses as Json[] | undefined) ?? []).map((s) => ({
			name: String(s.context),
			state: toCheckState(s.status),
			...(s.target_url ? { url: String(s.target_url) } : {}),
		}));
		return { state: overallState(checks), checks };
	}

	// ---- shared steps ----

	private async readIssue(operation: string, n: number): Promise<Issue> {
		const { json } = await this.http.call(operation, "GET", `${this.repoPath}/issues/${n}`);
		return toIssue(json);
	}

	private async readPull(operation: string, n: number): Promise<PullRequest> {
		const { json } = await this.http.call(operation, "GET", `${this.repoPath}/pulls/${n}`);
		return toPull(json);
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
	private async writeVersioned<T extends { version: Version }>(w: {
		operation: string;
		path: string;
		patch: Json;
		expect: Version;
		read: () => Promise<T>;
		parse: (json: Json) => T;
	}): Promise<WriteResult<T>> {
		const strictVersion = contentVersionOf(w.expect);
		if (strictVersion !== undefined) {
			const reply = await this.http.call(w.operation, "PATCH", w.path, { ...w.patch, content_version: strictVersion }, [409]);
			if (reply.status === 409) return this.conflict(w.read);
			return { status: "written", item: w.parse(reply.json), check: "strict" };
		}

		const fresh = await w.read();
		if (fresh.version !== w.expect) return { status: "conflict", current: fresh.version, changed: ["body"] };
		const reply = await this.http.call(w.operation, "PATCH", w.path, w.patch);
		return { status: "written", item: w.parse(reply.json), check: "best-effort" };
	}

	/** A 409 says the stored body differs; a fresh read names the current version. */
	private async conflict<T extends { version: Version }>(read: () => Promise<T>): Promise<WriteResult<T>> {
		const fresh = await read();
		return { status: "conflict", current: fresh.version, changed: ["body"] };
	}
}

// ---- mapping ----

function toVersion(json: Json, body: string): Version {
	if (typeof json.content_version === "number") return `${CONTENT_VERSION_PREFIX}${json.content_version}` as Version;
	return bodyVersion(String(json.updated_at ?? ""), body, "rc");
}

function contentVersionOf(version: Version): number | undefined {
	if (!version.startsWith(CONTENT_VERSION_PREFIX)) return undefined;
	const n = Number(version.slice(CONTENT_VERSION_PREFIX.length));
	return Number.isInteger(n) ? n : undefined;
}

function toIssue(json: Json): Issue {
	const body = String(json.body ?? "");
	return {
		number: Number(json.number),
		title: String(json.title ?? ""),
		body,
		labels: ((json.labels as Json[] | undefined) ?? []).map((l) => String(l.name)),
		state: json.state === "closed" ? "closed" : "open",
		author: String(json.user?.login ?? ""),
		updatedAt: String(json.updated_at ?? ""),
		version: toVersion(json, body),
	};
}

function toComment(json: Json): Comment {
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

function toPull(json: Json): PullRequest {
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

function toPermission(value: unknown): "none" | "read" | "write" | "admin" {
	if (value === "owner" || value === "admin") return "admin";
	if (value === "write" || value === "read") return value;
	return "none";
}

function toReviewState(value: unknown): ReviewState {
	if (value === "APPROVED") return "approved";
	if (value === "REQUEST_CHANGES") return "changes_requested";
	return "commented";
}

function toCheckState(value: unknown): Exclude<CheckState, "none"> {
	if (value === "success") return "success";
	if (value === "failure" || value === "error") return "failure";
	return "pending";
}

function overallState(checks: Check[]): CheckState {
	if (checks.length === 0) return "none";
	if (checks.some((c) => c.state === "failure")) return "failure";
	if (checks.some((c) => c.state === "pending")) return "pending";
	return "success";
}

// ---- small helpers ----

function parseJson(text: string): any {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).host;
	} catch {
		return undefined;
	}
}

function describe(error: unknown): string {
	const cause = (error as { cause?: { code?: string } } | undefined)?.cause?.code;
	return `${error instanceof Error ? error.message : String(error)}${cause ? ` (${cause})` : ""}`;
}
