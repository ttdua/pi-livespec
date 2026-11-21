// REST routes of the fake GitHub API, over `FakeGhData`. Pure: no I/O.
// Stricter than GitHub in one place: adding an unknown label to an issue
// answers 422 (GitHub would create it), so adapters must create labels.

import {
	type CommentRec,
	type FakeGhData,
	type IssueRec,
	type PermissionLevel,
	type PullRec,
	type ReviewCommentRec,
	type ReviewRec,
	tick,
} from "./state.ts";

// No parameter properties: node runs this file by stripping types only.
export class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface ApiRequest {
	method: string;
	/** Token from the environment of this `gh` call; `undefined` means the active account acts. */
	token?: string;
	/** Route without query string and leading slash. */
	path: string;
	query: URLSearchParams;
	body: Record<string, unknown>;
}

type Handler = (match: RegExpMatchArray, req: ApiRequest) => unknown;

const notFound = (what: string): never => {
	throw new HttpError(404, `Not Found: ${what}`);
};

const unprocessable = (message: string): never => {
	throw new HttpError(422, `Validation Failed: ${message}`);
};

const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

function userJson(login: string): { login: string } {
	return { login };
}

function issueJson(data: FakeGhData, issue: IssueRec, isPull = false): unknown {
	return {
		number: issue.number,
		html_url: `https://github.com/${data.repo}/${isPull ? "pull" : "issues"}/${issue.number}`,
		title: issue.title,
		body: issue.body,
		labels: issue.labels.map((name) => ({ name })),
		state: issue.state,
		user: userJson(issue.author),
		created_at: issue.createdAt,
		updated_at: issue.updatedAt,
		...(isPull ? { pull_request: {} } : {}),
	};
}

function commentJson(comment: CommentRec): unknown {
	return {
		id: comment.id,
		user: userJson(comment.author),
		body: comment.body,
		created_at: comment.createdAt,
		updated_at: comment.updatedAt,
	};
}

/** The list endpoint omits `merged`, as GitHub does; only `merged_at` is there. */
function pullJson(pull: PullRec, detailed: boolean): unknown {
	return {
		number: pull.number,
		state: pull.state,
		title: pull.title,
		body: pull.body,
		head: { ref: pull.head, sha: `sha-of-${pull.head}` },
		base: { ref: pull.base },
		user: userJson(pull.author),
		merged_at: pull.mergedAt ?? null,
		created_at: pull.createdAt,
		updated_at: pull.updatedAt,
		...(detailed ? { merged: pull.merged } : {}),
	};
}

function pullAsIssue(pull: PullRec): IssueRec {
	return { ...pull, labels: [] };
}

function findIssue(data: FakeGhData, n: string): IssueRec {
	return data.issues[n] ?? notFound(`issue ${n}`);
}

function findPull(data: FakeGhData, n: string): PullRec {
	return data.pulls[n] ?? notFound(`pull ${n}`);
}

function wantedStates(query: URLSearchParams): (state: string) => boolean {
	const wanted = query.get("state") ?? "open";
	return (state) => wanted === "all" || wanted === state;
}

function requireLabelsExist(data: FakeGhData, labels: string[]): void {
	const missing = labels.filter((name) => !data.labels.includes(name));
	if (missing.length > 0) unprocessable(`labels do not exist: ${missing.join(", ")}`);
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function listIssues(data: FakeGhData, req: ApiRequest): unknown {
	const stateOk = wantedStates(req.query);
	const labels = (req.query.get("labels") ?? "").split(",").filter(Boolean);
	const issues = Object.values(data.issues)
		.filter((i) => stateOk(i.state) && labels.every((l) => i.labels.includes(l)))
		.map((i) => issueJson(data, i));
	// GitHub lists pull requests as issues too; callers must filter them.
	const pulls = labels.length > 0 ? [] : Object.values(data.pulls).filter((p) => stateOk(p.state)).map((p) => issueJson(data, pullAsIssue(p), true));
	return [...issues, ...pulls];
}

function createIssue(data: FakeGhData, req: ApiRequest, actor: string): unknown {
	const labels = stringList(req.body.labels);
	requireLabelsExist(data, labels);
	const now = tick(data);
	const number = data.nextNumber++;
	const issue: IssueRec = {
		number,
		title: text(req.body.title),
		body: text(req.body.body),
		labels,
		state: "open",
		author: actor,
		createdAt: now,
		updatedAt: now,
	};
	data.issues[String(number)] = issue;
	return issueJson(data, issue);
}

function patchIssue(data: FakeGhData, n: string, req: ApiRequest): unknown {
	const issue = findIssue(data, n);
	if (typeof req.body.title === "string") issue.title = req.body.title;
	if (typeof req.body.body === "string") issue.body = req.body.body;
	if (req.body.state === "open" || req.body.state === "closed") issue.state = req.body.state;
	issue.updatedAt = tick(data);
	return issueJson(data, issue);
}

function addIssueLabels(data: FakeGhData, n: string, req: ApiRequest): unknown {
	const issue = findIssue(data, n);
	const labels = stringList(req.body.labels);
	requireLabelsExist(data, labels);
	for (const label of labels) if (!issue.labels.includes(label)) issue.labels.push(label);
	issue.updatedAt = tick(data);
	return issue.labels.map((name) => ({ name }));
}

function removeIssueLabel(data: FakeGhData, n: string, name: string): unknown {
	const issue = findIssue(data, n);
	if (!issue.labels.includes(name)) notFound(`label ${name} on issue ${n}`);
	issue.labels = issue.labels.filter((l) => l !== name);
	issue.updatedAt = tick(data);
	return issue.labels.map((label) => ({ name: label }));
}

function createLabel(data: FakeGhData, req: ApiRequest): unknown {
	const name = text(req.body.name);
	if (data.labels.includes(name)) unprocessable(`label ${name} already_exists`);
	data.labels.push(name);
	data.labelCreates[name] = (data.labelCreates[name] ?? 0) + 1;
	return { name };
}

function createComment(data: FakeGhData, n: string, req: ApiRequest, actor: string): unknown {
	findIssue(data, n);
	const now = tick(data);
	const comment: CommentRec = {
		id: data.nextCommentId++,
		issue: Number(n),
		author: actor,
		body: text(req.body.body),
		createdAt: now,
		updatedAt: now,
	};
	data.comments[String(comment.id)] = comment;
	return commentJson(comment);
}

function patchComment(data: FakeGhData, id: string, req: ApiRequest): unknown {
	const comment = data.comments[id] ?? notFound(`comment ${id}`);
	comment.body = text(req.body.body, comment.body);
	comment.updatedAt = tick(data);
	return commentJson(comment);
}

function listPulls(data: FakeGhData, req: ApiRequest): unknown {
	const stateOk = wantedStates(req.query);
	const head = req.query.get("head");
	const branch = head?.slice(head.indexOf(":") + 1);
	return Object.values(data.pulls)
		.filter((p) => stateOk(p.state) && (branch === undefined || p.head === branch))
		.map((p) => pullJson(p, false));
}

function createPull(data: FakeGhData, req: ApiRequest, actor: string): unknown {
	const now = tick(data);
	const number = data.nextNumber++;
	const pull: PullRec = {
		number,
		state: "open",
		merged: false,
		head: text(req.body.head),
		base: text(req.body.base),
		title: text(req.body.title),
		body: text(req.body.body),
		author: actor,
		files: [],
		reviews: [],
		reviewComments: [],
		createdAt: now,
		updatedAt: now,
	};
	data.pulls[String(number)] = pull;
	return pullJson(pull, true);
}

function patchPull(data: FakeGhData, n: string, req: ApiRequest): unknown {
	const pull = findPull(data, n);
	if (typeof req.body.title === "string") pull.title = req.body.title;
	if (typeof req.body.body === "string") pull.body = req.body.body;
	pull.updatedAt = tick(data);
	return pullJson(pull, true);
}

function createReviewComment(data: FakeGhData, n: string, req: ApiRequest, actor: string): unknown {
	const pull = findPull(data, n);
	if (typeof req.body.commit_id !== "string") unprocessable("commit_id is missing");
	const comment: ReviewCommentRec = {
		id: data.nextCommentId++,
		path: text(req.body.path),
		line: Number(req.body.line),
		body: text(req.body.body),
		author: actor,
		updatedAt: tick(data),
	};
	pull.reviewComments.push(comment);
	return reviewCommentJson(comment);
}

function reviewJson(review: ReviewRec): unknown {
	return { id: review.id, user: userJson(review.author), state: review.state, body: review.body, submitted_at: review.submittedAt };
}

function reviewCommentJson(comment: ReviewCommentRec): unknown {
	return { id: comment.id, path: comment.path, line: comment.line, body: comment.body, user: userJson(comment.author), updated_at: comment.updatedAt };
}

/** Statuses seeded as plain commit statuses: the legacy API. */
function commitStatuses(data: FakeGhData, ref: string): unknown {
	const statuses = (data.statuses[ref] ?? []).filter((s) => !s.checkRun);
	return { statuses: statuses.map((s) => ({ context: s.name, state: s.state, target_url: s.url ?? null })) };
}

/** Statuses seeded as check runs: pending maps to `in_progress`, the rest to `completed`. */
function checkRuns(data: FakeGhData, ref: string): unknown {
	const runs = (data.statuses[ref] ?? []).filter((s) => s.checkRun);
	return {
		total_count: runs.length,
		check_runs: runs.map((s) => ({
			name: s.name,
			status: s.state === "pending" ? "in_progress" : "completed",
			conclusion: s.state === "pending" ? null : s.state,
			details_url: s.url ?? null,
		})),
	};
}

function permissionOf(data: FakeGhData, login: string): unknown {
	const level: PermissionLevel = data.permissions[login] ?? "none";
	return { permission: level, user: userJson(login) };
}

function routes(data: FakeGhData, actor: string): [string, RegExp, Handler][] {
	return [
		["GET", /^issues$/, (_m, req) => listIssues(data, req)],
		["POST", /^issues$/, (_m, req) => createIssue(data, req, actor)],
		["GET", /^issues\/(\d+)$/, (m) => issueJson(data, findIssue(data, m[1]))],
		["PATCH", /^issues\/(\d+)$/, (m, req) => patchIssue(data, m[1], req)],
		["POST", /^issues\/(\d+)\/labels$/, (m, req) => addIssueLabels(data, m[1], req)],
		["DELETE", /^issues\/(\d+)\/labels\/(.+)$/, (m) => removeIssueLabel(data, m[1], decodeURIComponent(m[2]))],
		["GET", /^labels$/, () => data.labels.map((name) => ({ name }))],
		["POST", /^labels$/, (_m, req) => createLabel(data, req)],
		["GET", /^issues\/(\d+)\/comments$/, (m) => Object.values(data.comments).filter((c) => c.issue === Number(m[1])).map(commentJson)],
		["POST", /^issues\/(\d+)\/comments$/, (m, req) => createComment(data, m[1], req, actor)],
		["GET", /^issues\/comments\/(\d+)$/, (m) => commentJson(data.comments[m[1]] ?? notFound(`comment ${m[1]}`))],
		["PATCH", /^issues\/comments\/(\d+)$/, (m, req) => patchComment(data, m[1], req)],
		["GET", /^pulls$/, (_m, req) => listPulls(data, req)],
		["POST", /^pulls$/, (_m, req) => createPull(data, req, actor)],
		["GET", /^pulls\/(\d+)$/, (m) => pullJson(findPull(data, m[1]), true)],
		["PATCH", /^pulls\/(\d+)$/, (m, req) => patchPull(data, m[1], req)],
		["GET", /^pulls\/(\d+)\/files$/, (m) => findPull(data, m[1]).files.map((filename) => ({ filename }))],
		[
			"GET",
			/^pulls\/(\d+)\/reviews$/,
			(m) => findPull(data, m[1]).reviews.map(reviewJson),
		],
		[
			"GET",
			/^pulls\/(\d+)\/comments$/,
			(m) => findPull(data, m[1]).reviewComments.map(reviewCommentJson),
		],
		["POST", /^pulls\/(\d+)\/comments$/, (m, req) => createReviewComment(data, m[1], req, actor)],
		["GET", /^commits\/(.+)\/check-runs$/, (m) => checkRuns(data, decodeURIComponent(m[1]))],
		["GET", /^commits\/(.+)\/status$/, (m) => commitStatuses(data, decodeURIComponent(m[1]))],
		["GET", /^collaborators\/(.+)\/permission$/, (m) => permissionOf(data, decodeURIComponent(m[1]))],
	];
}

/**
 * The login a request acts as: the account owning `token`, else the active
 * account when no token is sent and someone is logged in, else `undefined`.
 */
export function resolveActor(data: FakeGhData, token: string | undefined): string | undefined {
	if (token !== undefined) return data.accounts.find((a) => a.token === token)?.login;
	return data.authenticated ? data.login : undefined;
}

/** `permissions.push` of the served repo for `login`: its account flag, else its collaborator level. */
function canPush(data: FakeGhData, login: string): boolean {
	const account = data.accounts.find((a) => a.login === login);
	if (account) return account.push;
	const level = data.permissions[login] ?? "none";
	return level === "write" || level === "admin";
}

function repoJson(data: FakeGhData, login: string): unknown {
	return { full_name: data.repo, permissions: { pull: true, push: canPush(data, login), admin: false } };
}

/** Serves one request. Throws `HttpError` for non-2xx answers. */
export function handleApi(data: FakeGhData, req: ApiRequest): unknown {
	const actor = resolveActor(data, req.token);
	if (actor === undefined) {
		throw new HttpError(401, req.token === undefined ? "Requires authentication" : "Bad credentials");
	}
	if (req.method === "GET" && req.path === "user") return userJson(actor);
	if (req.method === "GET" && req.path === `repos/${data.repo}`) return repoJson(data, actor);

	const prefix = `repos/${data.repo}/`;
	if (!req.path.startsWith(prefix)) return notFound(req.path);
	const rest = req.path.slice(prefix.length);
	for (const [method, pattern, handler] of routes(data, actor)) {
		const match = method === req.method ? rest.match(pattern) : null;
		if (match) return handler(match, req);
	}
	return notFound(`${req.method} ${req.path}`);
}
