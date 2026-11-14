import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ForgeError } from "./errors.ts";
import type {
	CheckSummary,
	Comment,
	Forge,
	ForgeKind,
	Issue,
	IssueQuery,
	PullRequest,
	Review,
	ReviewComment,
	Version,
	WriteResult,
} from "./types.ts";

export interface CachedForgeOptions {
	/** Defaults to `~/.pi/agent/livespec/cache`. */
	cacheRoot?: string;
	host: string;
	owner: string;
	repo: string;
}

/** On-disk shape of one cached issue. The cache is disposable: deleting it loses no durable state. */
interface CacheEntry {
	issue: Issue;
	version: Version;
	fetchedAt: string;
}

const DEFAULT_CACHE_ROOT = join(homedir(), ".pi", "agent", "livespec", "cache");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isIssueShape(value: unknown, n: number): value is Issue {
	if (!isRecord(value)) return false;
	return (
		value.number === n &&
		isString(value.title) &&
		isString(value.body) &&
		Array.isArray(value.labels) &&
		value.labels.every(isString) &&
		(value.state === "open" || value.state === "closed") &&
		isString(value.author) &&
		isString(value.updatedAt) &&
		isString(value.version) &&
		value.version !== ""
	);
}

/** Validates untrusted cache JSON for issue `n`; anything else counts as not cached. */
function isCacheEntry(value: unknown, n: number): value is CacheEntry {
	if (!isRecord(value)) return false;
	return (
		isIssueShape(value.issue, n) &&
		isString(value.version) &&
		value.version !== "" &&
		isString(value.fetchedAt)
	);
}

function readOnlyError(operation: string, cause?: ForgeError): ForgeError {
	const detail = cause ? ` (${cause.message})` : "";
	return new ForgeError({
		code: "readonly",
		operation,
		message: `${operation} refused: the forge could not be reached${detail}; this cache is read-only until a read succeeds.`,
	});
}

function isUnreachable(error: unknown): error is ForgeError {
	return error instanceof ForgeError && error.code === "unreachable";
}

/**
 * Decorates a Forge with a per-issue read cache and read-only mode.
 *
 * An `unreachable` failure from the inner forge enters read-only mode: `getIssue`
 * falls back to the cached copy marked `stale`, and every write is refused with
 * `ForgeError("readonly")` without reaching the inner forge. Only a later successful
 * read leaves read-only mode; a completing write never does. HTTP and auth failures never change the mode.
 */
export class CachedForge implements Forge {
	readonly kind: ForgeKind;
	private readonly cacheDir: string;
	private readOnly = false;

	constructor(
		private readonly inner: Forge,
		opts: CachedForgeOptions,
	) {
		this.kind = inner.kind;
		this.cacheDir = join(
			opts.cacheRoot ?? DEFAULT_CACHE_ROOT,
			opts.host,
			opts.owner,
			opts.repo,
		);
	}

	isReadOnly(): boolean {
		return this.readOnly;
	}

	whoami(): Promise<{ login: string }> {
		return this.track(() => this.inner.whoami());
	}

	async getIssue(n: number): Promise<Issue> {
		let issue: Issue;
		try {
			issue = await this.track(() => this.inner.getIssue(n));
		} catch (error) {
			// Only transport failures fall back to cache; an HTTP error from the forge is returned as-is.
			if (!isUnreachable(error)) throw error;
			const cached = await this.readCache(n);
			if (!cached) throw error;
			return { ...cached.issue, stale: true };
		}
		await this.tryWriteCache(issue);
		return issue;
	}

	searchIssues(q: IssueQuery): Promise<Issue[]> {
		return this.track(() => this.inner.searchIssues(q));
	}

	getPermission(login: string): Promise<"none" | "read" | "write" | "admin"> {
		return this.track(() => this.inner.getPermission(login));
	}

	async createIssue(i: {
		title: string;
		body: string;
		labels: string[];
	}): Promise<Issue> {
		const issue = await this.writeAttempt("createIssue", () =>
			this.inner.createIssue(i),
		);
		await this.tryWriteCache(issue);
		return issue;
	}

	async updateIssueBody(
		n: number,
		body: string,
		expect: Version,
	): Promise<WriteResult<Issue>> {
		const result = await this.writeAttempt("updateIssueBody", () =>
			this.inner.updateIssueBody(n, body, expect),
		);
		if (result.status === "written") await this.tryWriteCache(result.item);
		return result;
	}

	async closeIssue(n: number): Promise<void> {
		await this.writeAttempt("closeIssue", () => this.inner.closeIssue(n));
	}

	async reopenIssue(n: number): Promise<void> {
		await this.writeAttempt("reopenIssue", () => this.inner.reopenIssue(n));
	}

	async addLabels(n: number, labels: string[]): Promise<void> {
		await this.writeAttempt("addLabels", () => this.inner.addLabels(n, labels));
	}

	async removeLabels(n: number, labels: string[]): Promise<void> {
		await this.writeAttempt("removeLabels", () =>
			this.inner.removeLabels(n, labels),
		);
	}

	listComments(n: number): Promise<Comment[]> {
		return this.track(() => this.inner.listComments(n));
	}

	createComment(n: number, body: string): Promise<Comment> {
		return this.writeAttempt("createComment", () =>
			this.inner.createComment(n, body),
		);
	}

	updateComment(
		id: string,
		body: string,
		expect: Version,
	): Promise<WriteResult<Comment>> {
		return this.writeAttempt("updateComment", () =>
			this.inner.updateComment(id, body, expect),
		);
	}

	findOpenPullRequest(head: string): Promise<PullRequest | null> {
		return this.track(() => this.inner.findOpenPullRequest(head));
	}

	getPullRequest(n: number): Promise<PullRequest> {
		return this.track(() => this.inner.getPullRequest(n));
	}

	listPullRequests(q: {
		state: "open" | "closed" | "all";
		head?: string;
	}): Promise<PullRequest[]> {
		return this.track(() => this.inner.listPullRequests(q));
	}

	getPullRequestFiles(pr: number): Promise<string[]> {
		return this.track(() => this.inner.getPullRequestFiles(pr));
	}

	listReviews(pr: number): Promise<Review[]> {
		return this.track(() => this.inner.listReviews(pr));
	}

	createPullRequest(p: {
		head: string;
		base: string;
		title: string;
		body: string;
	}): Promise<PullRequest> {
		return this.writeAttempt("createPullRequest", () =>
			this.inner.createPullRequest(p),
		);
	}

	updatePullRequest(
		n: number,
		p: { title?: string; body?: string },
		expect: Version,
	): Promise<WriteResult<PullRequest>> {
		return this.writeAttempt("updatePullRequest", () =>
			this.inner.updatePullRequest(n, p, expect),
		);
	}

	listReviewComments(pr: number): Promise<ReviewComment[]> {
		return this.track(() => this.inner.listReviewComments(pr));
	}

	async createReviewComment(
		pr: number,
		c: { path: string; line: number; body: string },
	): Promise<void> {
		await this.writeAttempt("createReviewComment", () =>
			this.inner.createReviewComment(pr, c),
		);
	}

	getChecks(ref: string): Promise<CheckSummary> {
		return this.track(() => this.inner.getChecks(ref));
	}

	/** Runs one inner read: success leaves read-only mode, `unreachable` enters it, other errors pass through. */
	private async track<T>(call: () => Promise<T>): Promise<T> {
		const value = await this.enterOnUnreachable(call);
		this.readOnly = false;
		return value;
	}

	/** Runs one inner call; `unreachable` enters read-only mode, but success never leaves it. */
	private async enterOnUnreachable<T>(call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} catch (error) {
			if (isUnreachable(error)) this.readOnly = true;
			throw error;
		}
	}

	/**
	 * Runs one write. Refused without calling the inner forge while read-only; an `unreachable`
	 * failure from the inner forge is reported as `readonly`. Other errors pass through unchanged.
	 */
	private async writeAttempt<T>(
		operation: string,
		call: () => Promise<T>,
	): Promise<T> {
		if (this.readOnly) throw readOnlyError(operation);
		try {
			return await this.enterOnUnreachable(call);
		} catch (error) {
			if (isUnreachable(error)) throw readOnlyError(operation, error);
			throw error;
		}
	}

	private issueFile(n: number): string {
		return join(this.cacheDir, `${n}.json`);
	}

	/** Returns undefined for a missing, unreadable or corrupt file: the cache is disposable, so it counts as not cached. */
	private async readCache(n: number): Promise<CacheEntry | undefined> {
		try {
			const parsed: unknown = JSON.parse(
				await readFile(this.issueFile(n), "utf8"),
			);
			return isCacheEntry(parsed, n) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	/** Best-effort: a failed cache write must not fail a forge call that already succeeded. */
	private async tryWriteCache(issue: Issue): Promise<void> {
		try {
			await this.writeCache(issue);
		} catch {
			// Ignored deliberately: the cache is disposable and no logging infrastructure exists yet.
		}
	}

	private async writeCache(issue: Issue): Promise<void> {
		const entry: CacheEntry = {
			issue,
			version: issue.version,
			fetchedAt: new Date().toISOString(),
		};
		const file = this.issueFile(issue.number);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
	}
}
