// Per-issue cache of raw comments, keyed by the issue's `updatedAt` and bounded
// by a freshness window. Comments are stored unfiltered: callers filter own
// marked comments by the current login on every read (forge-markers rule).

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isOffline } from "../forge/errors.ts";
import { registerKind } from "../forge/markers.ts";
import type { Comment, Forge, Issue } from "../forge/types.ts";

/** Marker kind of an optional-skill note: id `<phase>.<skill>`, data `{ phase, skill, reason }`. */
export const SKILL_NOTE_KIND = "skill-note";
registerKind(SKILL_NOTE_KIND);

/** Comment edits and deletes do not change `updatedAt` on every forge; this bound keeps reuse safe anyway. */
export const DEFAULT_COMMENTS_TTL_MS = 300_000;

export type CommentsCacheOptions = {
	/** Per-repository directory, `<cacheRoot>/<host>/<owner>/<repo>`. */
	dir: string;
	now?: () => number;
	ttlMs?: number;
};

export type CommentsRead = { comments: Comment[]; stale: boolean };

/** On-disk shape of `<n>.comments.json`. */
type Entry = { updatedAt: string; fetchedAt: number; comments: Comment[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isComment(value: unknown): value is Comment {
	if (!isRecord(value)) return false;
	return ["id", "author", "body", "createdAt", "updatedAt", "version"].every((k) => typeof value[k] === "string");
}

/** Validates untrusted cache JSON; anything else counts as not cached. */
function isEntry(value: unknown): value is Entry {
	return (
		isRecord(value) &&
		typeof value.updatedAt === "string" &&
		typeof value.fetchedAt === "number" &&
		Array.isArray(value.comments) &&
		value.comments.every(isComment)
	);
}


export class CommentsCache {
	private readonly dir: string;
	private readonly now: () => number;
	private readonly ttlMs: number;

	constructor(o: CommentsCacheOptions) {
		this.dir = o.dir;
		this.now = o.now ?? Date.now;
		this.ttlMs = o.ttlMs ?? DEFAULT_COMMENTS_TTL_MS;
	}

	/**
	 * Raw comments of `issue`. A fresh entry for the same `updatedAt` is reused. A stale issue (read-only
	 * mode) or an unreachable forge serves the cached copy marked stale; without one the forge error is thrown.
	 */
	async list(forge: Forge, issue: Issue): Promise<CommentsRead> {
		const cached = await this.read(issue.number);
		if (cached && issue.stale) return { comments: cached.comments, stale: true };
		if (cached && this.isFresh(cached, issue)) return { comments: cached.comments, stale: false };
		try {
			const comments = await forge.listComments(issue.number);
			await this.tryWrite(issue.number, { updatedAt: issue.updatedAt, fetchedAt: this.now(), comments });
			return { comments, stale: false };
		} catch (error) {
			if (cached && isOffline(error)) return { comments: cached.comments, stale: true };
			throw error;
		}
	}

	/** Drops the entry of issue `n`; called after every livespec write to that issue. */
	async invalidate(n: number): Promise<void> {
		await rm(this.file(n), { force: true });
	}

	private isFresh(entry: Entry, issue: Issue): boolean {
		return entry.updatedAt === issue.updatedAt && this.now() - entry.fetchedAt < this.ttlMs;
	}

	private file(n: number): string {
		return join(this.dir, `${n}.comments.json`);
	}

	/** A missing, unreadable or corrupt file counts as not cached: the cache is disposable. */
	private async read(n: number): Promise<Entry | undefined> {
		let text: string;
		try {
			text = await readFile(this.file(n), "utf8");
		} catch {
			return undefined;
		}
		try {
			const parsed: unknown = JSON.parse(text);
			return isEntry(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	/** Best-effort, like the issue cache: a failed cache write must not fail a read that already succeeded. */
	private async tryWrite(n: number, entry: Entry): Promise<void> {
		try {
			await mkdir(this.dir, { recursive: true });
			await writeFile(this.file(n), `${JSON.stringify(entry)}\n`, "utf8");
		} catch {
			// Ignored deliberately: the next read refetches from the forge.
		}
	}
}
