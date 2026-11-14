// World for the shared contract suite. Each fake backend (in-memory, fake `gh`,
// loopback Gitea) implements it so the suite can change forge state behind the
// adapter's back and verify results from the forge's side.

import type { CheckState, Forge, IssueState, ReviewComment, ReviewState } from "../../src/forge/types.ts";

/** Login the adapter under test is authenticated as. */
export const BOT_LOGIN = "livespec-bot";

/** An account other than `BOT_LOGIN`, used for foreign comments. */
export const OTHER_LOGIN = "mallory";

export interface SeedIssue {
	title?: string;
	body?: string;
	/** Labels are created in the repository when missing. */
	labels?: string[];
	state?: IssueState;
	/** Defaults to `OTHER_LOGIN`. */
	author?: string;
}

export interface SeedPullRequest {
	head: string;
	base?: string;
	title?: string;
	body?: string;
	state?: "open" | "closed";
	merged?: boolean;
	files?: string[];
}

export interface SeedReview {
	author: string;
	state: ReviewState;
	body: string;
}

export interface SeedStatus {
	name: string;
	state: Exclude<CheckState, "none">;
	url?: string;
}

/**
 * Backend the contract suite runs against. Seed and inspect methods act on
 * the forge directly and never go through `forge`. A fresh world starts with
 * no issues, pull requests, comments or labels.
 */
export interface ContractWorld {
	/** Adapter under test, authenticated as `BOT_LOGIN`. */
	readonly forge: Forge;

	/** Creates an issue on the forge and returns its number. */
	seedIssue(issue?: SeedIssue): Promise<number>;
	/** Replaces an issue body as another client would. */
	editBodyBehindBack(n: number, body: string): Promise<void>;
	/** Current issue body, read from the forge. */
	bodyOf(n: number): Promise<string>;

	/** Adds a comment written by `author` and returns its id. */
	postComment(n: number, author: string, body: string): Promise<string>;
	/** Current comment body, read from the forge. */
	commentBodyOf(id: string): Promise<string>;

	/** Whether the repository has the label. */
	hasLabel(name: string): Promise<boolean>;
	/** Deletes the label from the repository (and from issues). */
	dropLabel(name: string): Promise<void>;
	/** Create-label calls the adapter has made for `name` since the world was built. Seeding does not count. */
	labelCreateCount(name: string): Promise<number>;

	/** Creates a pull request and returns its number. */
	seedPullRequest(pr: SeedPullRequest): Promise<number>;
	/** Replaces a pull request body as another client would. */
	editPullRequestBodyBehindBack(n: number, body: string): Promise<void>;
	seedReview(pr: number, review: SeedReview): Promise<void>;
	/** Commit status (or check run) on `ref`. */
	seedStatus(ref: string, status: SeedStatus): Promise<void>;
	/** Review comments as the forge stores them, for asserting `createReviewComment`. */
	reviewCommentsOf(pr: number): Promise<ReviewComment[]>;

	/** Sets the repository permission the forge reports for `login`. */
	setPermission(login: string, level: "none" | "read" | "write" | "admin"): Promise<void>;

	/** Every later call through `forge` fails as if the network were down. */
	makeUnreachable(): Promise<void>;
	restore(): Promise<void>;

	/** Releases servers and temp files; called after each test. */
	dispose?(): Promise<void>;
}

export type WorldFactory = () => Promise<ContractWorld> | ContractWorld;
