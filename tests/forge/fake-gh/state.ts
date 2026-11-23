// State of the fake `gh`: one JSON file shared by the fake executable (which
// serves API calls) and the test world (which seeds and inspects it).

import { readFileSync, renameSync, writeFileSync } from "node:fs";

export type PermissionLevel = "none" | "read" | "write" | "admin";

export interface IssueRec {
	number: number;
	title: string;
	body: string;
	labels: string[];
	state: "open" | "closed";
	author: string;
	createdAt: string;
	updatedAt: string;
}

export interface CommentRec {
	id: number;
	issue: number;
	author: string;
	body: string;
	createdAt: string;
	updatedAt: string;
}

export interface ReviewRec {
	id: number;
	author: string;
	/** Review state as the GitHub API spells it, e.g. `APPROVED`. */
	state: string;
	body: string;
	submittedAt: string;
}

export interface ReviewCommentRec {
	id: number;
	path: string;
	/** `null` for a file-level or an outdated comment, as GitHub sends it. */
	line: number | null;
	originalLine?: number | null;
	body: string;
	author: string;
	updatedAt: string;
}

export interface PullRec {
	number: number;
	state: "open" | "closed";
	merged: boolean;
	mergedAt?: string;
	head: string;
	base: string;
	title: string;
	body: string;
	author: string;
	files: string[];
	reviews: ReviewRec[];
	reviewComments: ReviewCommentRec[];
	createdAt: string;
	updatedAt: string;
}

export interface StatusRec {
	name: string;
	state: string;
	url?: string;
	/** Served by the check-runs endpoint when true, by the commit status endpoint otherwise. */
	checkRun?: boolean;
}

/** One `gh api` call the fake served, in order. Auth checks are not logged. */
export interface CallRec {
	method: string;
	route: string;
	body?: unknown;
}

/** A `gh` account known to the fake; a request carrying its token acts as it. */
export interface AccountRec {
	login: string;
	token: string;
	/** Write access to the served repo, as `GET repos/{o}/{r}` reports in `permissions.push`. */
	push: boolean;
}

/** Token variables one fake `gh` invocation saw in its environment; an empty value counts as unset. */
export interface TokenEnvRec {
	GH_TOKEN?: string;
	GH_ENTERPRISE_TOKEN?: string;
}

export interface FakeGhData {
	/** `owner/repo` the fake serves; any other repo route answers 404. */
	repo: string;
	/** Login of the active `gh` account: acts for requests that carry no token. */
	login: string;
	/** Accounts `gh auth status --json hosts` lists and whose tokens the fake accepts. */
	accounts: AccountRec[];
	authenticated: boolean;
	unreachable: boolean;
	clock: number;
	/** Issues and pull requests share one number space, as on GitHub. */
	nextNumber: number;
	nextCommentId: number;
	issues: Record<string, IssueRec>;
	comments: Record<string, CommentRec>;
	pulls: Record<string, PullRec>;
	labels: string[];
	/** Create-label API calls by name; seeding does not count. */
	labelCreates: Record<string, number>;
	permissions: Record<string, PermissionLevel>;
	statuses: Record<string, StatusRec[]>;
	calls: CallRec[];
	/** argv of every fake `gh` invocation (auth checks included), in order. */
	argvLog: string[][];
	/** Token env of every fake `gh` invocation, aligned with `argvLog`. */
	envLog: TokenEnvRec[];
}

export function emptyData(repo: string, login: string): FakeGhData {
	return {
		repo,
		login,
		accounts: [],
		authenticated: true,
		unreachable: false,
		clock: 0,
		nextNumber: 1,
		nextCommentId: 1,
		issues: {},
		comments: {},
		pulls: {},
		labels: [],
		labelCreates: {},
		permissions: {},
		statuses: {},
		calls: [],
		argvLog: [],
		envLog: [],
	};
}

/** Deterministic, strictly increasing timestamps. */
export function tick(data: FakeGhData): string {
	data.clock += 1;
	return new Date(Date.UTC(2026, 0, 1, 0, 0, data.clock)).toISOString();
}

/** File-backed store. Every access reads and rewrites the whole file. */
export class FakeGhStore {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	init(data: FakeGhData): void {
		writeFileSync(this.path, JSON.stringify(data));
	}

	read(): FakeGhData {
		return JSON.parse(readFileSync(this.path, "utf8")) as FakeGhData;
	}

	/** Atomic (temp file + rename): adapters may run several fake `gh` processes at once. */
	write(data: FakeGhData): void {
		const temp = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
		writeFileSync(temp, JSON.stringify(data));
		renameSync(temp, this.path);
	}

	/** Runs `fn` on the current data and saves the result. */
	update<T>(fn: (data: FakeGhData) => T): T {
		const data = this.read();
		const result = fn(data);
		this.write(data);
		return result;
	}
}
