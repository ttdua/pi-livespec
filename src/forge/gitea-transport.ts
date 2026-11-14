// Authenticated JSON transport for Gitea `/api/v1`: fetch with a timeout,
// pagination, and mapping of failures to ForgeError.

import { ForgeError, isAuthStatus } from "./errors.ts";
import { type Guard, isObject, shapeError } from "./gitea-dto.ts";
import { findGiteaToken, type TeaLookup } from "./tea-config.ts";

/** Default limit for one Gitea HTTP request, response body included. */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const PAGE_SIZE = 50;
/** Hard stop for a runaway paginator (a server that never returns an empty page). */
const MAX_PAGES = 1000;

export interface GiteaTransportOptions extends Omit<TeaLookup, "env"> {
	fetch?: typeof fetch;
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
}

export interface Reply {
	status: number;
	/** Parsed body; `undefined` when the body was empty. */
	json: unknown;
}

/** Authenticated JSON transport. Maps failures to ForgeError; callers pass `accept` for statuses they handle themselves. */
export class GiteaTransport {
	private token?: string;
	private readonly fetchFn: typeof fetch;
	private readonly env: Record<string, string | undefined>;

	constructor(private readonly opts: GiteaTransportOptions) {
		this.fetchFn = opts.fetch ?? fetch;
		this.env = opts.env ?? process.env;
	}

	async call(operation: string, method: string, path: string, body?: unknown, accept: number[] = []): Promise<Reply> {
		const token = await this.resolveToken(operation);
		const signal = AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
				signal,
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
		const code = isAuthStatus(response.status) ? "auth" : "http";
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
		const token = await findGiteaToken({ ...this.opts, env: this.env });
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
}

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

function describe(error: unknown): string {
	const cause = (error as { cause?: { code?: string } } | undefined)?.cause?.code;
	return `${error instanceof Error ? error.message : String(error)}${cause ? ` (${cause})` : ""}`;
}
