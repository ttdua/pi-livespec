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

function isUnreachable(error: unknown): boolean {
	return error instanceof ForgeError && error.code === "unreachable";
}

/**
 * Decorates a Forge with a per-issue read cache and read-only mode.
 *
 * An `unreachable` failure from the inner forge enters read-only mode: `getIssue`
 * falls back to the cached copy marked `stale`, and every write is refused with
 * `ForgeError("readonly")` without reaching the inner forge. Any later successful
 * call leaves read-only mode. HTTP and auth failures never change the mode.
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
		this.cacheDir = join(opts.cacheRoot ?? DEFAULT_CACHE_ROOT, opts.host, opts.owner, opts.repo);
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
		await this.writeCache(issue);
		return issue;
	}

	searchIssues(q: IssueQuery): Promise<Issue[]> {
		return this.track(() => this.inner.searchIssues(q));
	}

	getPermission(login: string): Promise<"none" | "read" | "write" | "admin"> {
		return this.track(() => this.inner.getPermission(login));
	}

	async createIssue(i: { title: string; body: string; labels: string[] }): Promise<Issue> {
		this.assertWritable("createIssue");
		const issue = await this.track(() => this.inner.createIssue(i));
		await this.writeCache(issue);
		return issue;
	}

	async updateIssueBody(n: number, body: string, expect: Version): Promise<WriteResult<Issue>> {
		this.assertWritable("updateIssueBody");
		const result = await this.track(() => this.inner.updateIssueBody(n, body, expect));
		if (result.status === "written") await this.writeCache(result.item);
		return result;
	}

	async closeIssue(n: number): Promise<void> {
		this.assertWritable("closeIssue");
		await this.track(() => this.inner.closeIssue(n));
	}

	async reopenIssue(n: number): Promise<void> {
		this.assertWritable("reopenIssue");
		await this.track(() => this.inner.reopenIssue(n));
	}

	async addLabels(n: number, labels: string[]): Promise<void> {
		this.assertWritable("addLabels");
		await this.track(() => this.inner.addLabels(n, labels));
	}

	async removeLabels(n: number, labels: string[]): Promise<void> {
		this.assertWritable("removeLabels");
		await this.track(() => this.inner.removeLabels(n, labels));
	}

	listComments(n: number): Promise<Comment[]> {
		return this.track(() => this.inner.listComments(n));
	}

	async createComment(n: number, body: string): Promise<Comment> {
		this.assertWritable("createComment");
		return this.track(() => this.inner.createComment(n, body));
	}

	async updateComment(id: string, body: string, expect: Version): Promise<WriteResult<Comment>> {
		this.assertWritable("updateComment");
		return this.track(() => this.inner.updateComment(id, body, expect));
	}

	findOpenPullRequest(head: string): Promise<PullRequest | null> {
		return this.track(() => this.inner.findOpenPullRequest(head));
	}

	getPullRequest(n: number): Promise<PullRequest> {
		return this.track(() => this.inner.getPullRequest(n));
	}

	listPullRequests(q: { state: "open" | "closed" | "all"; head?: string }): Promise<PullRequest[]> {
		return this.track(() => this.inner.listPullRequests(q));
	}

	getPullRequestFiles(pr: number): Promise<string[]> {
		return this.track(() => this.inner.getPullRequestFiles(pr));
	}

	listReviews(pr: number): Promise<Review[]> {
		return this.track(() => this.inner.listReviews(pr));
	}

	async createPullRequest(p: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
		this.assertWritable("createPullRequest");
		return this.track(() => this.inner.createPullRequest(p));
	}

	async updatePullRequest(
		n: number,
		p: { title?: string; body?: string },
		expect: Version,
	): Promise<WriteResult<PullRequest>> {
		this.assertWritable("updatePullRequest");
		return this.track(() => this.inner.updatePullRequest(n, p, expect));
	}

	listReviewComments(pr: number): Promise<ReviewComment[]> {
		return this.track(() => this.inner.listReviewComments(pr));
	}

	async createReviewComment(pr: number, c: { path: string; line: number; body: string }): Promise<void> {
		this.assertWritable("createReviewComment");
		await this.track(() => this.inner.createReviewComment(pr, c));
	}

	getChecks(ref: string): Promise<CheckSummary> {
		return this.track(() => this.inner.getChecks(ref));
	}

	/** Runs one inner call: success leaves read-only mode, `unreachable` enters it, other errors pass through. */
	private async track<T>(call: () => Promise<T>): Promise<T> {
		try {
			const value = await call();
			this.readOnly = false;
			return value;
		} catch (error) {
			if (isUnreachable(error)) this.readOnly = true;
			throw error;
		}
	}

	private assertWritable(operation: string): void {
		if (!this.readOnly) return;
		throw new ForgeError({
			code: "readonly",
			operation,
			message: `${operation} refused: the forge is unreachable and this cache is read-only. Retry when the forge is reachable.`,
		});
	}

	private issueFile(n: number): string {
		return join(this.cacheDir, `${n}.json`);
	}

	private async readCache(n: number): Promise<CacheEntry | undefined> {
		let raw: string;
		try {
			raw = await readFile(this.issueFile(n), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		return JSON.parse(raw) as CacheEntry;
	}

	private async writeCache(issue: Issue): Promise<void> {
		const entry: CacheEntry = { issue, version: issue.version, fetchedAt: new Date().toISOString() };
		const file = this.issueFile(issue.number);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
	}
}
