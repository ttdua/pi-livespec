// The local audit state: the suggestion cursors and the pending audit reasons,
// kept in `<git common dir>/livespec/audit.json`, shared by every worktree of a clone.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withRootLock } from "../content/root-lock.ts";
import type { Git } from "../engine/git.ts";

export type PendingAudit = { kind: "initiative"; initiative: number } | { kind: "commit"; sha: string; capabilities: string[] };

export type AuditState = {
	/** Last first-parent commit of the integration branch checked for suggestions. */
	cursor?: string;
	/** Audited commit up to which the `declared-none` detector last ran to the end. */
	fixCursor?: string;
	auditedCommit?: string;
	pending: PendingAudit[];
};

const STATE_DIR = "livespec";
const STATE_FILE = "audit.json";
/** Lock root under the state directory; `withRootLock` takes `<it>/.lock`. */
const LOCK_ROOT = "audit";
const CURSORS = ["cursor", "fixCursor", "auditedCommit"] as const;
const TEMP_BYTES = 6;

const stateDir = async (git: Pick<Git, "commonDir">): Promise<string> => join(await git.commonDir(), STATE_DIR);

/** The stored state; a missing, unreadable or malformed file is no state (deleting it loses at most one suggestion). */
export async function readAuditState(git: Pick<Git, "commonDir">): Promise<AuditState> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(await stateDir(git), STATE_FILE), "utf8"));
		return isAuditState(parsed) ? parsed : { pending: [] };
	} catch {
		return { pending: [] };
	}
}

/** Writes the state atomically: a temp file in the same directory, then a rename; a failed write leaves the previous file. */
export async function writeAuditState(git: Pick<Git, "commonDir">, s: AuditState): Promise<void> {
	const dir = await stateDir(git);
	await mkdir(dir, { recursive: true });
	const temp = join(dir, `${STATE_FILE}.${process.pid}.${randomBytes(TEMP_BYTES).toString("hex")}.tmp`);
	try {
		await writeFile(temp, `${JSON.stringify(s, null, 2)}\n`);
		await rename(temp, join(dir, STATE_FILE));
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

/**
 * Read → transform → write under a lock shared by every worktree of the clone, so a concurrent update is never lost.
 * `transform` must not do slow I/O (compute it before); returning the same object skips the write. Throws when the
 * lock cannot be taken in time.
 */
export async function updateAuditState(git: Pick<Git, "commonDir">, transform: (s: AuditState) => AuditState | Promise<AuditState>): Promise<AuditState> {
	const locked = await withRootLock(join(await stateDir(git), LOCK_ROOT), "wait", async () => {
		const s = await readAuditState(git);
		const next = await transform(s);
		if (next !== s) await writeAuditState(git, next);
		return next;
	});
	if (!locked.acquired) throw new Error("the audit state is locked by another session");
	return locked.value;
}

function isAuditState(v: unknown): v is AuditState {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const o = v as Record<string, unknown>;
	return CURSORS.every((k) => o[k] === undefined || typeof o[k] === "string") && Array.isArray(o.pending) && o.pending.every(isPending);
}

function isPending(v: unknown): v is PendingAudit {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	if (o.kind === "initiative") return Number.isInteger(o.initiative);
	return o.kind === "commit" && typeof o.sha === "string" && Array.isArray(o.capabilities) && o.capabilities.every((c) => typeof c === "string");
}
