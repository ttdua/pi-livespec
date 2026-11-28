// Append-only ledger on `refs/livespec/<n>`: plumbing commits that never touch the index
// or a working tree, moved by compare-and-swap, and validated reads cached by commit.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { isLedgerKind } from "../core/record-kinds.ts";
import type { GitExec } from "../engine/git-exec.ts";
import {
	type AppendInput,
	LEDGER_META_FILE,
	LEDGER_SCHEMA,
	type LedgerEntry,
	LedgerError,
	type LedgerRead,
	appendText,
	assertEntry,
	fileFor,
	isEntryFile,
	newRef,
	parseFile,
} from "./entry.ts";
import { ABSENT, backoff, gitFailure, isLostSwap, ledgerRef, readRef } from "./refs.ts";

export { ledgerRef } from "./refs.ts";

const CAS_RETRIES = 5;
const READ_CACHE_LIMIT = 64;
const BLOB_CACHE_LIMIT = 256;
const LIVESPEC_IDENTITY: Record<string, string> = {
	GIT_AUTHOR_NAME: "livespec",
	GIT_AUTHOR_EMAIL: "livespec@localhost",
	GIT_COMMITTER_NAME: "livespec",
	GIT_COMMITTER_EMAIL: "livespec@localhost",
};
type TreeFile = { path: string; blob: string };

const readCache = new Map<string, LedgerRead>();
/** Tree listings by `repo\0commit`; a commit names an immutable tree. */
const treeCache = new Map<string, readonly TreeFile[]>();
/** Blob contents by `repo\0sha`; a blob sha names immutable content. */
const blobCache = new Map<string, string>();

/** The validated entries of the ledger tree at `commit`; never throws on hostile content. */
export async function readTree(exec: GitExec, root: string, commit: string, n: number): Promise<LedgerRead> {
	const key = `${n}:${commit}`;
	const cached = readCache.get(key);
	if (cached) return copyRead(cached);
	const read = await readTreeUncached(exec, root, commit, n);
	cacheRead(key, read);
	return copyRead(read);
}

/** The entries at the local tip of `refs/livespec/<n>`; empty without a tip. */
export async function readLedger(exec: GitExec, root: string, n: number): Promise<LedgerRead> {
	const tip = await readTip(exec, root, n);
	return tip ? readTree(exec, root, tip, n) : { entries: [], warnings: [] };
}

/** Commits `entries` appended to their files on top of `base` (or a fresh ledger), and returns the commit sha. */
export async function commitEntries(exec: GitExec, root: string, n: number, base: string | undefined, entries: LedgerEntry[]): Promise<string> {
	ledgerRef(n);
	if (entries.length === 0) throw new LedgerError("git", "commitEntries needs at least one entry");
	for (const entry of entries) assertEntry(entry);
	const scratch = await mkdtemp(join(tmpdir(), "livespec-ledger-"));
	try {
		const contents = await changedFiles(exec, root, n, base, entries);
		const tree = await writeTreeWith(exec, root, scratch, base, contents);
		return await commitTree(exec, root, tree, base, commitMessage(entries));
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Appends one entry to the ledger of change `n` by compare-and-swap, retrying a lost swap up to 5 times. */
export async function appendEntry(exec: GitExec, root: string, n: number, input: AppendInput, now: () => Date = () => new Date()): Promise<LedgerEntry> {
	const ref = ledgerRef(n);
	if (!isLedgerKind(input.kind)) throw new LedgerError("kind", `\`${String(input.kind)}\` is not a ledger kind`);
	const identity = { ref: newRef(input.id), at: now().toISOString() };
	assertEntry(buildEntry(input, identity, 1));
	let lastFailure = "";
	for (let attempt = 0; attempt <= CAS_RETRIES; attempt++) {
		const tip = await readTip(exec, root, n);
		const current = tip ? await readTree(exec, root, tip, n) : { entries: [], warnings: [] };
		const entry = buildEntry(input, identity, nextSeq(current.entries));
		const commit = await commitEntries(exec, root, n, tip, [entry]);
		const swap = await exec(["update-ref", "-m", commitMessage([entry]), ref, commit, tip ?? ABSENT], { cwd: root });
		if (swap.code === 0) return entry;
		lastFailure = swap.spawnError ?? swap.stderr.trim();
		if (!(await isLostSwap(exec, root, ref, tip, lastFailure))) throw gitFailure(["update-ref", ref], lastFailure);
		await backoff(attempt);
	}
	throw new LedgerError("cas", `another writer kept moving ${ref}; gave up after ${CAS_RETRIES} retries: ${lastFailure}`);
}

/** The local tip of `refs/livespec/<n>`, or undefined when the ref does not exist. */
function readTip(exec: GitExec, root: string, n: number): Promise<string | undefined> {
	return readRef(exec, root, ledgerRef(n));
}

async function readTreeUncached(exec: GitExec, root: string, commit: string, n: number): Promise<LedgerRead> {
	const files = await listTree(exec, root, commit);
	const metaProblem = await ledgerMetaProblem(exec, root, files, n);
	if (metaProblem) return { tip: commit, entries: [], warnings: [`ledger of #${n} read as empty: ${metaProblem}`] };
	const warnings: string[] = [];
	const parsed: LedgerEntry[] = [];
	for (const file of files.filter((f) => isEntryFile(f.path))) {
		const result = parseFile(file.path, await catBlob(exec, root, file.blob));
		parsed.push(...result.entries);
		warnings.push(...result.warnings);
	}
	return { tip: commit, entries: dropRepeatedRefs(orderBySeq(parsed), warnings), warnings };
}

async function ledgerMetaProblem(exec: GitExec, root: string, files: readonly TreeFile[], n: number): Promise<string | undefined> {
	const meta = files.find((f) => f.path === LEDGER_META_FILE);
	if (!meta) return `${LEDGER_META_FILE} is missing`;
	let doc: unknown;
	try {
		doc = parse(await catBlob(exec, root, meta.blob));
	} catch {
		return `${LEDGER_META_FILE} is not valid YAML`;
	}
	if (typeof doc !== "object" || doc === null) return `${LEDGER_META_FILE} is not a mapping`;
	const { schema, issue } = doc as Record<string, unknown>;
	if (schema !== LEDGER_SCHEMA) return `${LEDGER_META_FILE} has unknown schema ${JSON.stringify(schema) ?? "(none)"}`;
	if (issue !== n) return `${LEDGER_META_FILE} names issue ${JSON.stringify(issue) ?? "(none)"}, expected ${n}`;
	return undefined;
}

/** Entries by `seq`, keeping file order among equal `seq` values (a gap or repeat is not an error). */
function orderBySeq(entries: LedgerEntry[]): LedgerEntry[] {
	return entries.map((entry, index) => ({ entry, index })).sort((a, b) => a.entry.seq - b.entry.seq || a.index - b.index).map(({ entry }) => entry);
}

function dropRepeatedRefs(entries: LedgerEntry[], warnings: string[]): LedgerEntry[] {
	const seen = new Set<string>();
	return entries.filter((e) => {
		if (!seen.has(e.ref)) {
			seen.add(e.ref);
			return true;
		}
		warnings.push(`${fileFor(e.kind, e.data)}: skipped entry: repeated ref \`${e.ref}\``);
		return false;
	});
}

/** The new content of every file `entries` touch (and `ledger.yaml` for a fresh ledger). */
async function changedFiles(exec: GitExec, root: string, n: number, base: string | undefined, entries: LedgerEntry[]): Promise<Map<string, string>> {
	const files = base ? await listTree(exec, root, base) : [];
	const metaProblem = base ? await ledgerMetaProblem(exec, root, files, n) : undefined;
	// Reads ignore a ledger with a bad `ledger.yaml`, so anything appended to it would be invisible.
	if (metaProblem) throw new LedgerError("git", `refusing to append to the ledger of #${n}: ${metaProblem}`);
	const existing = new Map(files.map((f) => [f.path, f.blob]));
	const byFile = new Map<string, LedgerEntry[]>();
	for (const entry of entries) {
		const path = fileFor(entry.kind, entry.data);
		byFile.set(path, [...(byFile.get(path) ?? []), entry]);
	}
	const contents = new Map<string, string>();
	if (!base) contents.set(LEDGER_META_FILE, stringify({ schema: LEDGER_SCHEMA, issue: n }));
	for (const [path, added] of byFile) {
		const blob = existing.get(path);
		contents.set(path, appendText(path, blob ? await catBlob(exec, root, blob) : "", added));
	}
	return contents;
}

/** Builds the tree of `base` plus `contents` in a temporary index under `scratch`. */
async function writeTreeWith(exec: GitExec, root: string, scratch: string, base: string | undefined, contents: Map<string, string>): Promise<string> {
	const env = { GIT_INDEX_FILE: join(scratch, "index") };
	await git(exec, root, base ? ["read-tree", base] : ["read-tree", "--empty"], env);
	let fileNo = 0;
	for (const [path, text] of contents) {
		const file = join(scratch, `blob-${fileNo++}`);
		await writeFile(file, text);
		const blob = await git(exec, root, ["hash-object", "-w", "--no-filters", "--", file]);
		await git(exec, root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], env);
	}
	return git(exec, root, ["write-tree"], env);
}

function commitTree(exec: GitExec, root: string, tree: string, base: string | undefined, message: string): Promise<string> {
	const parent = base ? ["-p", base] : [];
	return git(exec, root, ["commit-tree", "--no-gpg-sign", tree, ...parent, "-m", message], LIVESPEC_IDENTITY);
}

function commitMessage(entries: LedgerEntry[]): string {
	const [first] = entries;
	return entries.length === 1 && first ? `livespec: ${first.kind} ${first.id}` : `livespec: ${entries.length} entries`;
}

function buildEntry(input: AppendInput, identity: { ref: string; at: string }, seq: number): LedgerEntry {
	const entry: LedgerEntry = { ref: identity.ref, kind: input.kind, id: input.id, seq, at: identity.at, data: input.data };
	if (input.after !== undefined) entry.after = input.after;
	return entry;
}

function nextSeq(entries: LedgerEntry[]): number {
	return entries.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
}

async function listTree(exec: GitExec, root: string, commit: string): Promise<readonly TreeFile[]> {
	const key = `${root}\0${commit}`;
	const known = treeCache.get(key);
	if (known) return known;
	const files = await listTreeUncached(exec, root, commit);
	if (treeCache.size >= READ_CACHE_LIMIT) treeCache.delete(treeCache.keys().next().value as string);
	treeCache.set(key, files);
	return files;
}

async function listTreeUncached(exec: GitExec, root: string, commit: string): Promise<readonly TreeFile[]> {
	const out = await git(exec, root, ["ls-tree", "-r", "-z", "--full-tree", commit], undefined, false);
	return out
		.split("\0")
		.filter(Boolean)
		.flatMap((line) => {
			const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(line);
			return match?.[1] && match[2] ? [{ blob: match[1], path: match[2] }] : [];
		});
}

async function catBlob(exec: GitExec, root: string, blob: string): Promise<string> {
	const key = `${root}\0${blob}`;
	const known = blobCache.get(key);
	if (known !== undefined) return known;
	const text = await git(exec, root, ["cat-file", "blob", blob], undefined, false);
	if (blobCache.size >= BLOB_CACHE_LIMIT) blobCache.delete(blobCache.keys().next().value as string);
	blobCache.set(key, text);
	return text;
}

async function git(exec: GitExec, root: string, args: string[], env?: Record<string, string>, trim = true): Promise<string> {
	const r = await exec(args, env ? { cwd: root, env } : { cwd: root });
	if (r.code !== 0) throw gitFailure(args, r.spawnError ?? r.stderr);
	return trim ? r.stdout.trim() : r.stdout;
}

function cacheRead(key: string, read: LedgerRead): void {
	if (readCache.size >= READ_CACHE_LIMIT) {
		const oldest = readCache.keys().next().value;
		if (oldest !== undefined) readCache.delete(oldest);
	}
	readCache.set(key, read);
}

function copyRead(read: LedgerRead): LedgerRead {
	return { ...read, entries: [...read.entries], warnings: [...read.warnings] };
}
