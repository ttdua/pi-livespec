// Loopback fake of the Gitea REST API (`/api/v1`), shaped by probe (g) in
// docs/evidence/host-seams.md: `content_version` on issues and pulls (409 when
// stale, no ETag), comment edits without a version, label, review and
// commit-status endpoints. With `withContentVersion: false` it behaves like an
// older server: the field is neither sent nor honored.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BOT_LOGIN } from "./world.ts";

export const FAKE_TOKEN = "fake-gitea-token";

type Permission = "none" | "read" | "write" | "admin";
type StatusState = "success" | "failure" | "pending";
type ReviewEvent = "APPROVED" | "REQUEST_CHANGES" | "COMMENT";

interface IssueRec {
	number: number;
	title: string;
	body: string;
	labels: string[];
	state: "open" | "closed";
	author: string;
	updatedAt: string;
	cv: number;
}

interface PullRec {
	number: number;
	state: "open" | "closed";
	merged: boolean;
	head: string;
	base: string;
	title: string;
	body: string;
	files: string[];
	reviews: ReviewRec[];
	updatedAt: string;
	cv: number;
}

interface ReviewRec {
	id: number;
	author: string;
	event: ReviewEvent;
	body: string;
	comments: { path: string; position: number; body: string; author: string }[];
}

interface CommentRec {
	id: number;
	issue: number;
	author: string;
	body: string;
	createdAt: string;
	updatedAt: string;
}

interface StatusRec {
	context: string;
	status: StatusState;
	url?: string;
}

/** One request the adapter made. `body` is the parsed JSON payload, when there was one. */
export interface RecordedCall {
	method: string;
	path: string;
	authorization?: string;
	body?: Record<string, unknown>;
}

export interface FakeGiteaOptions {
	/** Default true. False simulates a server without `content_version`. */
	withContentVersion?: boolean;
	owner?: string;
	repo?: string;
}

interface Reply {
	status: number;
	json?: unknown;
}

interface Ctx {
	groups: string[];
	query: URLSearchParams;
	body: Record<string, unknown>;
}

type Handler = (ctx: Ctx) => Reply;

const ok = (json: unknown): Reply => ({ status: 200, json });
const created = (json: unknown): Reply => ({ status: 201, json });
const notFound = (what: string): Reply => ({ status: 404, json: { message: `${what} not found` } });

export class FakeGitea {
	readonly calls: RecordedCall[] = [];
	readonly labelCreates = new Map<string, number>();
	private readonly issues = new Map<number, IssueRec>();
	private readonly pulls = new Map<number, PullRec>();
	private readonly comments = new Map<number, CommentRec>();
	private readonly labels = new Map<string, number>();
	private readonly statuses = new Map<string, StatusRec[]>();
	private readonly permissions = new Map<string, Permission>();
	private readonly routes: [string, RegExp, Handler][] = [];
	private unreachable = false;
	private nextNumber = 1;
	private nextId = 1;
	private clock = 0;

	private constructor(
		private readonly server: Server,
		private readonly withContentVersion: boolean,
		private readonly prefix: string,
	) {
		this.buildRoutes();
		server.on("request", (req, res) => void this.serve(req, res));
	}

	static async start(opts: FakeGiteaOptions = {}): Promise<FakeGitea> {
		const server = createServer();
		const fake = new FakeGitea(server, opts.withContentVersion ?? true, `/api/v1/repos/${opts.owner ?? "o"}/${opts.repo ?? "r"}`);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return fake;
	}

	get url(): string {
		return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}

	async close(): Promise<void> {
		this.server.closeAllConnections();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	/** While true, every connection is dropped without an answer. */
	setUnreachable(value: boolean): void {
		this.unreachable = value;
	}

	// ---- seeding and inspection (act on state directly, never recorded) ----

	seedIssue(i: { title?: string; body?: string; labels?: string[]; state?: "open" | "closed"; author?: string }): number {
		for (const label of i.labels ?? []) this.addLabelRecord(label);
		const number = this.nextNumber++;
		this.issues.set(number, {
			number,
			title: i.title ?? `issue ${number}`,
			body: i.body ?? "",
			labels: [...(i.labels ?? [])],
			state: i.state ?? "open",
			author: i.author ?? "mallory",
			updatedAt: this.tick(),
			cv: 1,
		});
		return number;
	}

	editIssueBody(n: number, body: string): void {
		const issue = this.issue(n);
		issue.body = body;
		issue.cv += 1;
		issue.updatedAt = this.tick();
	}

	issueBody(n: number): string {
		return this.issue(n).body;
	}

	seedComment(n: number, author: string, body: string): number {
		return this.addComment(n, author, body).id;
	}

	commentBody(id: number): string {
		return this.comment(id).body;
	}

	hasLabel(name: string): boolean {
		return this.labels.has(name);
	}

	dropLabel(name: string): void {
		this.labels.delete(name);
		for (const issue of this.issues.values()) issue.labels = issue.labels.filter((l) => l !== name);
	}

	seedPull(p: { head: string; base?: string; title?: string; body?: string; state?: "open" | "closed"; merged?: boolean; files?: string[] }): number {
		const number = this.nextNumber++;
		this.pulls.set(number, {
			number,
			state: p.state ?? "open",
			merged: p.merged ?? false,
			head: p.head,
			base: p.base ?? "main",
			title: p.title ?? `pull ${number}`,
			body: p.body ?? "",
			files: p.files ?? [],
			reviews: [],
			updatedAt: this.tick(),
			cv: 1,
		});
		return number;
	}

	editPullBody(n: number, body: string): void {
		const pull = this.pull(n);
		pull.body = body;
		pull.cv += 1;
		pull.updatedAt = this.tick();
	}

	pullBody(n: number): string {
		return this.pull(n).body;
	}

	seedReview(n: number, r: { author: string; event: ReviewEvent; body: string }): void {
		this.addReview(this.pull(n), r.author, r.event, r.body, []);
	}

	reviewComments(n: number): { path: string; line: number; body: string; author: string }[] {
		return this.pull(n).reviews.flatMap((r) => r.comments.map((c) => ({ path: c.path, line: c.position, body: c.body, author: c.author })));
	}

	seedStatus(ref: string, s: StatusRec): void {
		this.statuses.set(ref, [...(this.statuses.get(ref) ?? []), { ...s }]);
	}

	setPermission(login: string, level: Permission): void {
		this.permissions.set(login, level);
	}

	// ---- http ----

	private async serve(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
		if (this.unreachable) {
			req.socket.destroy();
			return;
		}
		const url = new URL(req.url ?? "/", "http://fake");
		const method = req.method ?? "GET";
		const body = await readJson(req);
		this.calls.push({ method, path: url.pathname + url.search, authorization: req.headers.authorization, body });

		const reply = this.dispatch(method, url, req.headers.authorization, body ?? {});
		res.writeHead(reply.status, { "content-type": "application/json" });
		res.end(reply.json === undefined ? "" : JSON.stringify(reply.json));
	}

	private dispatch(method: string, url: URL, authorization: string | undefined, body: Record<string, unknown>): Reply {
		if (method === "GET" && url.pathname === "/api/v1/version") return ok({ version: "1.22.0" });
		if (authorization !== `token ${FAKE_TOKEN}`) return { status: 401, json: { message: "token is required" } };
		for (const [m, pattern, handler] of this.routes) {
			const match = m === method ? pattern.exec(url.pathname) : null;
			if (match) return handler({ groups: match.slice(1), query: url.searchParams, body });
		}
		return notFound(`${method} ${url.pathname}`);
	}

	private route(method: string, path: string | RegExp, handler: Handler): void {
		const source = typeof path === "string" ? path : path.source;
		this.routes.push([method, new RegExp(`^${source}$`), handler]);
	}

	private buildRoutes(): void {
		const r = this.prefix.replaceAll("/", "\\/");
		const id = "(\\d+)";
		this.route("GET", "/api/v1/user", () => ok({ login: BOT_LOGIN }));

		this.route("GET", `${r}/issues`, (c) => ok(this.pageOf(this.searchIssues(c.query), c.query).map((i) => this.issueJson(i))));
		this.route("POST", `${r}/issues`, (c) => created(this.issueJson(this.createIssue(c.body))));
		this.route("GET", `${r}/issues/${id}`, (c) => this.withIssue(c, (i) => ok(this.issueJson(i))));
		this.route("PATCH", `${r}/issues/${id}`, (c) => this.withIssue(c, (i) => this.patchIssue(i, c.body)));

		this.route("GET", `${r}/labels`, (c) => ok(this.pageOf([...this.labels], c.query).map(([name, labelId]) => ({ id: labelId, name }))));
		this.route("POST", `${r}/labels`, (c) => this.postLabel(c.body));
		this.route("POST", `${r}/issues/${id}/labels`, (c) => this.withIssue(c, (i) => this.labelIssue(i, c.body, false)));
		this.route("PUT", `${r}/issues/${id}/labels`, (c) => this.withIssue(c, (i) => this.labelIssue(i, c.body, true)));
		this.route("DELETE", `${r}/issues/${id}/labels/${id}`, (c) => this.withIssue(c, (i) => this.unlabelIssue(i, Number(c.groups[1]))));

		this.route("GET", `${r}/issues/${id}/comments`, (c) =>
			this.withIssue(c, (i) => ok(this.pageOf([...this.comments.values()].filter((x) => x.issue === i.number), c.query).map((x) => this.commentJson(x)))),
		);
		this.route("POST", `${r}/issues/${id}/comments`, (c) =>
			this.withIssue(c, (i) => created(this.commentJson(this.addComment(i.number, BOT_LOGIN, String(c.body.body ?? ""))))),
		);
		this.route("PATCH", `${r}/issues/comments/${id}`, (c) => this.patchComment(Number(c.groups[0]), c.body));

		this.route("GET", `${r}/pulls`, (c) => ok(this.pageOf(this.searchPulls(c.query), c.query).map((p) => this.pullJson(p))));
		this.route("POST", `${r}/pulls`, (c) =>
			created(this.pullJson(this.pull(this.seedPull({ head: String(c.body.head), base: String(c.body.base), title: String(c.body.title), body: String(c.body.body ?? "") })))),
		);
		this.route("GET", `${r}/pulls/${id}`, (c) => this.withPull(c, (p) => ok(this.pullJson(p))));
		this.route("PATCH", `${r}/pulls/${id}`, (c) => this.withPull(c, (p) => this.patchPull(p, c.body)));
		this.route("GET", `${r}/pulls/${id}/files`, (c) => this.withPull(c, (p) => ok(this.pageOf(p.files, c.query).map((filename) => ({ filename })))));
		this.route("GET", `${r}/pulls/${id}/reviews`, (c) => this.withPull(c, (p) => ok(p.reviews.map((x) => this.reviewJson(x)))));
		this.route("POST", `${r}/pulls/${id}/reviews`, (c) => this.withPull(c, (p) => this.postReview(p, c.body)));
		this.route("GET", `${r}/pulls/${id}/reviews/${id}/comments`, (c) =>
			this.withPull(c, (p) => {
				const review = p.reviews.find((x) => x.id === Number(c.groups[1]));
				return review ? ok(review.comments.map((x) => ({ path: x.path, position: x.position, body: x.body, user: { login: x.author } }))) : notFound("review");
			}),
		);

		this.route("GET", `${r}/commits/([^/]+)/status`, (c) => ok(this.combinedStatus(decodeURIComponent(c.groups[0]))));
		this.route("GET", `${r}/collaborators/([^/]+)/permission`, (c) => ok({ permission: this.permissions.get(decodeURIComponent(c.groups[0])) ?? "none" }));
	}

	// ---- handlers ----

	private withIssue(c: Ctx, fn: (i: IssueRec) => Reply): Reply {
		const issue = this.issues.get(Number(c.groups[0]));
		return issue ? fn(issue) : notFound("issue");
	}

	private withPull(c: Ctx, fn: (p: PullRec) => Reply): Reply {
		const pull = this.pulls.get(Number(c.groups[0]));
		return pull ? fn(pull) : notFound("pull");
	}

	private searchIssues(q: URLSearchParams): IssueRec[] {
		const state = q.get("state") ?? "open";
		const wanted = (q.get("labels") ?? "").split(",").filter(Boolean);
		const text = q.get("q")?.toLowerCase();
		return [...this.issues.values()].filter(
			(i) =>
				(state === "all" || i.state === state) &&
				wanted.every((l) => i.labels.includes(l)) &&
				(!text || `${i.title}\n${i.body}`.toLowerCase().includes(text)),
		);
	}

	private searchPulls(q: URLSearchParams): PullRec[] {
		const state = q.get("state") ?? "open";
		return [...this.pulls.values()].filter((p) => state === "all" || p.state === state);
	}

	private createIssue(b: Record<string, unknown>): IssueRec {
		const n = this.seedIssue({ title: String(b.title), body: String(b.body ?? ""), author: BOT_LOGIN });
		return this.issue(n);
	}

	private patchIssue(issue: IssueRec, b: Record<string, unknown>): Reply {
		if (typeof b.body === "string" || typeof b.title === "string") {
			const stale = this.isStale(issue.cv, b.content_version);
			if (stale) return { status: 409, json: { message: "the issue is already changed" } };
			if (typeof b.body === "string") issue.body = b.body;
			if (typeof b.title === "string") issue.title = b.title;
			issue.cv += 1;
		}
		if (b.state === "open" || b.state === "closed") issue.state = b.state;
		issue.updatedAt = this.tick();
		return created(this.issueJson(issue));
	}

	private patchPull(pull: PullRec, b: Record<string, unknown>): Reply {
		if (this.isStale(pull.cv, b.content_version)) return { status: 409, json: { message: "the pull request is already changed" } };
		if (typeof b.body === "string") pull.body = b.body;
		if (typeof b.title === "string") pull.title = b.title;
		pull.cv += 1;
		pull.updatedAt = this.tick();
		return created(this.pullJson(pull));
	}

	private isStale(current: number, sent: unknown): boolean {
		return this.withContentVersion && typeof sent === "number" && sent !== current;
	}

	private patchComment(id: number, b: Record<string, unknown>): Reply {
		const comment = this.comments.get(id);
		if (!comment) return notFound("comment");
		comment.body = String(b.body ?? "");
		comment.updatedAt = this.tick();
		return ok(this.commentJson(comment));
	}

	private postLabel(b: Record<string, unknown>): Reply {
		const name = String(b.name);
		if (this.labels.has(name)) return { status: 409, json: { message: "label exists" } };
		this.labelCreates.set(name, (this.labelCreates.get(name) ?? 0) + 1);
		this.addLabelRecord(name);
		return created({ id: this.labels.get(name), name });
	}

	private labelIssue(issue: IssueRec, b: Record<string, unknown>, replace: boolean): Reply {
		const names = (b.labels as unknown[]).map(String);
		if (!names.every((n) => this.labels.has(n))) return { status: 422, json: { message: "label does not exist" } };
		issue.labels = replace ? names : [...new Set([...issue.labels, ...names])];
		return ok(issue.labels.map((name) => ({ id: this.labels.get(name), name })));
	}

	private unlabelIssue(issue: IssueRec, labelId: number): Reply {
		issue.labels = issue.labels.filter((name) => this.labels.get(name) !== labelId);
		return { status: 204 };
	}

	private postReview(pull: PullRec, b: Record<string, unknown>): Reply {
		const event = (b.event as ReviewEvent | undefined) ?? "COMMENT";
		const inline = ((b.comments as Record<string, unknown>[] | undefined) ?? []).map((c) => ({
			path: String(c.path),
			position: Number(c.new_position),
			body: String(c.body),
			author: BOT_LOGIN,
		}));
		return ok(this.reviewJson(this.addReview(pull, BOT_LOGIN, event, String(b.body ?? ""), inline)));
	}

	private addReview(pull: PullRec, author: string, event: ReviewEvent, body: string, comments: ReviewRec["comments"]): ReviewRec {
		const review = { id: this.nextId++, author, event, body, comments };
		pull.reviews.push(review);
		return review;
	}

	private combinedStatus(ref: string): { state: string; statuses: unknown[] } {
		const latest = new Map<string, StatusRec>();
		for (const s of this.statuses.get(ref) ?? []) latest.set(s.context, s);
		const all = [...latest.values()];
		const state = all.length === 0 ? "pending" : all.some((s) => s.status === "failure") ? "failure" : all.some((s) => s.status === "pending") ? "pending" : "success";
		return { state, statuses: all.map((s) => ({ context: s.context, status: s.status, target_url: s.url ?? "" })) };
	}

	// ---- json shapes ----

	private issueJson(i: IssueRec): Record<string, unknown> {
		return {
			number: i.number,
			title: i.title,
			body: i.body,
			state: i.state,
			user: { login: i.author },
			updated_at: i.updatedAt,
			labels: i.labels.map((name) => ({ id: this.labels.get(name), name })),
			...(this.withContentVersion ? { content_version: i.cv } : {}),
		};
	}

	private pullJson(p: PullRec): Record<string, unknown> {
		return {
			number: p.number,
			state: p.state,
			merged: p.merged,
			merged_at: p.merged ? p.updatedAt : null,
			head: { ref: p.head },
			base: { ref: p.base },
			title: p.title,
			body: p.body,
			updated_at: p.updatedAt,
			...(this.withContentVersion ? { content_version: p.cv } : {}),
		};
	}

	private commentJson(c: CommentRec): Record<string, unknown> {
		return { id: c.id, body: c.body, user: { login: c.author }, created_at: c.createdAt, updated_at: c.updatedAt };
	}

	private reviewJson(r: ReviewRec): Record<string, unknown> {
		return { id: r.id, state: r.event, body: r.body, user: { login: r.author }, comments_count: r.comments.length };
	}

	// ---- helpers ----

	private pageOf<T>(items: T[], q: URLSearchParams): T[] {
		const limit = Number(q.get("limit") ?? 30);
		const page = Number(q.get("page") ?? 1);
		return items.slice((page - 1) * limit, page * limit);
	}

	private addLabelRecord(name: string): void {
		if (!this.labels.has(name)) this.labels.set(name, this.nextId++);
	}

	private addComment(issue: number, author: string, body: string): CommentRec {
		const now = this.tick();
		const comment = { id: this.nextId++, issue, author, body, createdAt: now, updatedAt: now };
		this.comments.set(comment.id, comment);
		return comment;
	}

	private issue(n: number): IssueRec {
		const found = this.issues.get(n);
		if (!found) throw new Error(`fake gitea: no issue ${n}`);
		return found;
	}

	private pull(n: number): PullRec {
		const found = this.pulls.get(n);
		if (!found) throw new Error(`fake gitea: no pull ${n}`);
		return found;
	}

	private comment(id: number): CommentRec {
		const found = this.comments.get(id);
		if (!found) throw new Error(`fake gitea: no comment ${id}`);
		return found;
	}

	private tick(): string {
		this.clock += 1;
		return new Date(Date.UTC(2026, 0, 1, 0, 0, this.clock)).toISOString();
	}
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	return text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
}
