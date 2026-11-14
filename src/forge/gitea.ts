// Gitea adapter over `/api/v1` with Node's built-in fetch. Issue and pull
// request body edits use `content_version` when the server sends it (strict
// check); otherwise they fall back to a re-read and compare (best-effort).

import { readFile } from "node:fs/promises";
import { homedir as osHomedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ForgeError } from "./errors.ts";
import { ensureLabels, type LabelRepo } from "./labels.ts";
import { assertOwnMarkedComment } from "./markers.ts";
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
	/** Path of the `tea` config; when omitted, tea's own lookup order is followed. */
	teaConfigPath?: string;
	/** Test seams for the default `tea` config lookup. */
	homedir?: string;
	platform?: NodeJS.Platform;
}

const PAGE_SIZE = 50;
/** Hard stop for a runaway paginator (a server that never returns an empty page). */
const MAX_PAGES = 1000;
const DEFAULT_LABEL_COLOR = "ededed";
const CONTENT_VERSION_PREFIX = "cv:";

// Minimal DTOs: only the fields the mapping reads. Everything else stays `unknown`.
interface UserDto {
	login?: string;
}
interface LabelDto {
	id?: number;
	name?: string;
}
interface IssueDto {
	number?: number;
	title?: string;
	body?: string;
	state?: string;
	user?: UserDto;
	updated_at?: string;
	content_version?: number;
	labels?: LabelDto[];
}
interface PullDto extends IssueDto {
	merged?: boolean;
	merged_at?: string | null;
	head?: { ref?: string };
	base?: { ref?: string };
}
interface CommentDto {
	id?: number;
	body?: string;
	user?: UserDto;
	created_at?: string;
	updated_at?: string;
}
interface ReviewDto {
	id?: number;
	state?: string;
	body?: string;
	user?: UserDto;
}
interface ReviewCommentDto {
	path?: string;
	line?: number;
	position?: number;
	body?: string;
	user?: UserDto;
}
interface StatusDto {
	context?: string;
	status?: string;
	target_url?: string;
}
type Json = Record<string, unknown>;

interface Reply {
	status: number;
	/** Parsed body; `undefined` when the body was empty. */
	json: unknown;
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
		let text: string;
		try {
			text = await response.text();
		} catch (error) {
			throw new ForgeError({ code: "unreachable", operation, message: `${operation}: reading the response failed: ${describe(error)}` });
		}
		if (response.ok) return { status: response.status, json: parseSuccessBody(operation, response.status, text) };

		const parsed = parseLenient(text);
		if (accept.includes(response.status)) return { status: response.status, json: parsed };
		const message = (parsed as { message?: unknown } | undefined)?.message;
		const detail = typeof message === "string" ? message : text.slice(0, 200);
		const code = response.status === 401 || response.status === 403 ? "auth" : "http";
		throw new ForgeError({ code, operation, status: response.status, message: `${operation}: HTTP ${response.status} ${detail}`.trim() });
	}

	/** A call whose successful body must be a JSON object. */
	async object<T>(operation: string, method: string, path: string, guard: Guard<T>, body?: unknown): Promise<T> {
		const reply = await this.call(operation, method, path, body);
		return this.asObject<T>(operation, reply, guard);
	}

	asObject<T>(operation: string, reply: Reply, guard: Guard<T>): T {
		if (!isObject(reply.json)) throw shapeError(operation, reply.status, "a JSON object");
		if (!guard(reply.json)) throw shapeError(operation, reply.status, "a well-formed object");
		return reply.json;
	}

	/** Reads every page of a paginated list endpoint. */
	async list<T>(operation: string, path: string, guard: Guard<T>): Promise<T[]> {
		const sep = path.includes("?") ? "&" : "?";
		return this.pages(operation, async (page) => this.getArray(operation, `${path}${sep}limit=${PAGE_SIZE}&page=${page}`, guard));
	}

	/**
	 * Calls `fetchPage` for page 1, 2, ... until a page is empty or holds only
	 * entries already seen (an endpoint that ignores `page`). The server may cap
	 * the page size below the requested limit, so a short page is not the end.
	 */
	async pages<T>(operation: string, fetchPage: (page: number) => Promise<T[]>): Promise<T[]> {
		const all: T[] = [];
		const seen = new Set<string>();
		for (let page = 1; page <= MAX_PAGES; page++) {
			const items = await fetchPage(page);
			const fresh = items.filter((item) => !seen.has(JSON.stringify(item)));
			if (fresh.length === 0) return all;
			for (const item of fresh) seen.add(JSON.stringify(item));
			all.push(...fresh);
		}
		throw new ForgeError({ code: "http", operation, message: `${operation}: pagination did not end after ${MAX_PAGES} pages` });
	}

	/** A single GET of an unpaginated list endpoint. */
	async getArray<T>(operation: string, path: string, guard: Guard<T>): Promise<T[]> {
		const reply = await this.call(operation, "GET", path);
		if (!Array.isArray(reply.json)) throw shapeError(operation, reply.status, "a JSON array");
		return reply.json.map((entry) => {
			if (!guard(entry)) throw shapeError(operation, reply.status, "a list of well-formed entries");
			return entry;
		});
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
		const config = await this.readTeaConfig();
		const host = hostOf(this.opts.baseUrl);
		const logins = (config as { logins?: { url?: string; token?: string }[] } | null)?.logins;
		const login = Array.isArray(logins) ? logins.find((l) => l?.url && hostOf(l.url) === host && l.token) : undefined;
		return login?.token;
	}

	/** The first readable `tea` config: the explicit path, else tea's own lookup order. */
	private async readTeaConfig(): Promise<unknown> {
		for (const path of this.teaConfigCandidates()) {
			let text: string;
			try {
				text = await readFile(path, "utf8");
			} catch {
				continue;
			}
			try {
				return parse(text);
			} catch {
				return undefined;
			}
		}
		return undefined;
	}

	private teaConfigCandidates(): string[] {
		if (this.opts.teaConfigPath) return [this.opts.teaConfigPath];
		const home = this.opts.homedir ?? osHomedir();
		const xdg = this.env.XDG_CONFIG_HOME;
		const base = xdg ? xdg : (this.opts.platform ?? osPlatform()) === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config");
		return [join(base, "tea", "config.yml"), join(home, ".tea", "tea.yml")];
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
		return items.map(toIssue);
	}

	async getPermission(login: string): Promise<"none" | "read" | "write" | "admin"> {
		const json = await this.http.object("getPermission", "GET", `${this.repoPath}/collaborators/${encodeURIComponent(login)}/permission`, isObject);
		return toPermission(json.permission);
	}

	async createIssue(i: { title: string; body: string; labels: string[] }): Promise<Issue> {
		const json = await this.http.object("createIssue", "POST", `${this.repoPath}/issues`, isIssueDto, { title: i.title, body: i.body });
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
		const items = await this.http.list("addLabels", `${this.repoPath}/labels`, isLabelDto);
		return items.map((l) => String(l.name));
	}

	async createLabel(name: string): Promise<void> {
		await this.http.call("addLabels", "POST", `${this.repoPath}/labels`, { name, color: DEFAULT_LABEL_COLOR });
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
		const [found] = await this.listPullRequests({ state: "open", head }, "findOpenPullRequest");
		return found ?? null;
	}

	async getPullRequest(n: number): Promise<PullRequest> {
		return this.readPull("getPullRequest", n);
	}

	async listPullRequests(q: { state: "open" | "closed" | "all"; head?: string }, operation = "listPullRequests"): Promise<PullRequest[]> {
		const items = await this.http.list(operation, `${this.repoPath}/pulls?state=${q.state}`, isPullDto);
		return items.map(toPull).filter((p) => q.head === undefined || p.head === q.head);
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
			const combined = await this.http.object("getChecks", "GET", `${path}?limit=${PAGE_SIZE}&page=${page}`, isObject);
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
		return toIssue(await this.http.object(operation, "GET", `${this.repoPath}/issues/${n}`, isIssueDto));
	}

	private async readPull(operation: string, n: number): Promise<PullRequest> {
		return toPull(await this.http.object(operation, "GET", `${this.repoPath}/pulls/${n}`, isPullDto));
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
	private async writeVersioned<T extends { version: Version }, D>(w: {
		operation: string;
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
			if (reply.status === 409) return this.conflict(w.read);
			return { status: "written", item: w.parse(this.http.asObject(w.operation, reply, w.guard)), check: "strict" };
		}

		const fresh = await w.read();
		if (fresh.version !== w.expect) return { status: "conflict", current: fresh.version, changed: ["body"] };
		const reply = await this.http.call(w.operation, "PATCH", w.path, w.patch);
		return { status: "written", item: w.parse(this.http.asObject(w.operation, reply, w.guard)), check: "best-effort" };
	}

	/** A 409 says the stored body differs; a fresh read names the current version. */
	private async conflict<T extends { version: Version }>(read: () => Promise<T>): Promise<WriteResult<T>> {
		const fresh = await read();
		return { status: "conflict", current: fresh.version, changed: ["body"] };
	}
}

// ---- mapping ----

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

function parseLenient(text: string): unknown {
	try {
		return text ? JSON.parse(text) : undefined;
	} catch {
		return undefined;
	}
}

/** An empty body is `undefined` (no payload); malformed JSON on a success status is an error. */
function parseSuccessBody(operation: string, status: number, text: string): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		throw new ForgeError({ code: "http", operation, status, message: `${operation}: HTTP ${status} response is not valid JSON` });
	}
}

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Guard<T> = (value: unknown) => value is T;

// ---- DTO guards: check only the fields the mapping reads (absent or null is fine) ----

function optional(value: unknown, type: "string" | "number" | "boolean"): boolean {
	return value === undefined || value === null || typeof value === type;
}

function optionalObject(value: unknown, check: (o: Json) => boolean): boolean {
	return value === undefined || value === null || (isObject(value) && check(value));
}

function isUserDto(value: unknown): value is UserDto {
	return isObject(value) && optional(value.login, "string");
}

function isLabelDto(value: unknown): value is LabelDto {
	return isObject(value) && optional(value.id, "number") && optional(value.name, "string");
}

function isIssueDto(value: unknown): value is IssueDto {
	return (
		isObject(value) &&
		optional(value.number, "number") &&
		optional(value.title, "string") &&
		optional(value.body, "string") &&
		optional(value.state, "string") &&
		optional(value.updated_at, "string") &&
		optional(value.content_version, "number") &&
		optionalObject(value.user, (u) => isUserDto(u)) &&
		(value.labels === undefined || value.labels === null || (Array.isArray(value.labels) && value.labels.every(isLabelDto)))
	);
}

const hasOptionalRef = (value: unknown): boolean => optionalObject(value, (o) => optional(o.ref, "string"));

function isPullDto(value: unknown): value is PullDto {
	if (!isIssueDto(value)) return false;
	const o = value as Json;
	return optional(o.merged, "boolean") && optional(o.merged_at, "string") && hasOptionalRef(o.head) && hasOptionalRef(o.base);
}

function isCommentDto(value: unknown): value is CommentDto {
	return (
		isObject(value) &&
		optional(value.id, "number") &&
		optional(value.body, "string") &&
		optional(value.created_at, "string") &&
		optional(value.updated_at, "string") &&
		optionalObject(value.user, (u) => isUserDto(u))
	);
}

function isReviewDto(value: unknown): value is ReviewDto {
	return isObject(value) && optional(value.id, "number") && optional(value.state, "string") && optional(value.body, "string") && optionalObject(value.user, (u) => isUserDto(u));
}

function isReviewCommentDto(value: unknown): value is ReviewCommentDto {
	return (
		isObject(value) &&
		optional(value.path, "string") &&
		optional(value.line, "number") &&
		optional(value.position, "number") &&
		optional(value.body, "string") &&
		optionalObject(value.user, (u) => isUserDto(u))
	);
}

function isFileDto(value: unknown): value is { filename?: string } {
	return isObject(value) && optional(value.filename, "string");
}

function isStatusDto(value: unknown): value is StatusDto {
	return isObject(value) && optional(value.context, "string") && optional(value.status, "string") && optional(value.target_url, "string");
}

function shapeError(operation: string, status: number, expected: string): ForgeError {
	return new ForgeError({ code: "http", operation, status, message: `${operation}: HTTP ${status} response is not ${expected}` });
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
