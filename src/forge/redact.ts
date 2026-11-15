// A `Forge` decorator that removes known tokens from every thrown error, so a
// forge message echoing a credential never reaches the session, card or tools.
// The session wraps the account adapter in it, below `CachedForge`.

import { redactTokens } from "../accounts/redact.ts";
import { ForgeError } from "./errors.ts";
import type { CheckSummary, Comment, Forge, ForgeKind, Issue, IssueQuery, PullRequest, Review, ReviewComment, Version, WriteResult } from "./types.ts";

export class RedactingForge implements Forge {
	readonly kind: ForgeKind;

	constructor(
		private readonly inner: Forge,
		private readonly tokens: () => string[],
	) {
		this.kind = inner.kind;
	}

	whoami(): Promise<{ login: string }> {
		return this.run(() => this.inner.whoami());
	}

	getIssue(n: number): Promise<Issue> {
		return this.run(() => this.inner.getIssue(n));
	}

	searchIssues(q: IssueQuery): Promise<Issue[]> {
		return this.run(() => this.inner.searchIssues(q));
	}

	getPermission(login: string): Promise<"none" | "read" | "write" | "admin"> {
		return this.run(() => this.inner.getPermission(login));
	}

	createIssue(i: { title: string; body: string; labels: string[] }): Promise<Issue> {
		return this.run(() => this.inner.createIssue(i));
	}

	updateIssueBody(n: number, body: string, expect: Version): Promise<WriteResult<Issue>> {
		return this.run(() => this.inner.updateIssueBody(n, body, expect));
	}

	closeIssue(n: number): Promise<void> {
		return this.run(() => this.inner.closeIssue(n));
	}

	reopenIssue(n: number): Promise<void> {
		return this.run(() => this.inner.reopenIssue(n));
	}

	addLabels(n: number, labels: string[]): Promise<void> {
		return this.run(() => this.inner.addLabels(n, labels));
	}

	removeLabels(n: number, labels: string[]): Promise<void> {
		return this.run(() => this.inner.removeLabels(n, labels));
	}

	listComments(n: number): Promise<Comment[]> {
		return this.run(() => this.inner.listComments(n));
	}

	createComment(n: number, body: string): Promise<Comment> {
		return this.run(() => this.inner.createComment(n, body));
	}

	updateComment(id: string, body: string, expect: Version): Promise<WriteResult<Comment>> {
		return this.run(() => this.inner.updateComment(id, body, expect));
	}

	findOpenPullRequest(head: string): Promise<PullRequest | null> {
		return this.run(() => this.inner.findOpenPullRequest(head));
	}

	getPullRequest(n: number): Promise<PullRequest> {
		return this.run(() => this.inner.getPullRequest(n));
	}

	listPullRequests(q: { state: "open" | "closed" | "all"; head?: string }): Promise<PullRequest[]> {
		return this.run(() => this.inner.listPullRequests(q));
	}

	getPullRequestFiles(pr: number): Promise<string[]> {
		return this.run(() => this.inner.getPullRequestFiles(pr));
	}

	listReviews(pr: number): Promise<Review[]> {
		return this.run(() => this.inner.listReviews(pr));
	}

	createPullRequest(p: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
		return this.run(() => this.inner.createPullRequest(p));
	}

	updatePullRequest(n: number, p: { title?: string; body?: string }, expect: Version): Promise<WriteResult<PullRequest>> {
		return this.run(() => this.inner.updatePullRequest(n, p, expect));
	}

	listReviewComments(pr: number): Promise<ReviewComment[]> {
		return this.run(() => this.inner.listReviewComments(pr));
	}

	createReviewComment(pr: number, c: { path: string; line: number; body: string }): Promise<void> {
		return this.run(() => this.inner.createReviewComment(pr, c));
	}

	getChecks(ref: string): Promise<CheckSummary> {
		return this.run(() => this.inner.getChecks(ref));
	}

	private async run<T>(call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} catch (error) {
			throw this.redact(error);
		}
	}

	/**
	 * The same error with every known token removed from its message; code, operation and status are
	 * kept. A thrown non-Error value becomes an `Error` with its redacted text.
	 */
	private redact(error: unknown): unknown {
		if (!(error instanceof Error)) return new Error(redactTokens(String(error), this.tokens()));
		const message = redactTokens(error.message, this.tokens());
		if (message === error.message) return error;
		if (error instanceof ForgeError) return new ForgeError({ code: error.code, operation: error.operation, status: error.status, message });
		return new Error(message);
	}
}
