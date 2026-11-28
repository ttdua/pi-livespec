// Ledger entry codec: the entry shape, its version, the file each kind lives in,
// and parsing of ledger files that anyone with push access may have written.

import { createHash, randomBytes } from "node:crypto";
import { parse, stringify } from "yaml";
import { type LedgerKind, isLedgerKind } from "../core/record-kinds.ts";

export type LedgerEntry = {
	ref: string;
	kind: LedgerKind;
	id: string;
	seq: number;
	at: string;
	after?: string;
	from?: string;
	data: unknown;
};

export type AppendInput = { kind: LedgerKind; id: string; data: unknown; after?: string };

/** `unreadable` names content that could not be read at all (an oversized blob, a file that is no sequence, a bad `ledger.yaml`): entries may be missing, so a replay or a write that depends on completeness must refuse. */
export type LedgerRead = { tip?: string; entries: LedgerEntry[]; warnings: string[]; unreadable?: string[] };

export type LedgerErrorCode = "kind" | "cas" | "unknown-offline" | "git";

export class LedgerError extends Error {
	constructor(
		readonly code: LedgerErrorCode,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "LedgerError";
	}
}

export const LEDGER_META_FILE = "ledger.yaml";
export const LEDGER_SCHEMA = 1;

const REF_SUFFIX_BYTES = 4;
const ID_PATTERN = /^[^\s~]+$/;
const REF_PATTERN = /^[^\s~]+~[0-9a-f]{8}$/;
const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const JSONL_FILES: Partial<Record<LedgerKind, string>> = {
	decision: "decisions.jsonl",
	dispatch: "dispatch.jsonl",
	"finding-summary": "findings.jsonl",
};

/** A fresh unique entry id `<id>~<8 lowercase hex>`. */
export function newRef(id: string): string {
	return `${id}~${randomBytes(REF_SUFFIX_BYTES).toString("hex")}`;
}

/** SHA-256 of the sorted-key, whitespace-free JSON of the entry without `seq`, so a replay keeps it. */
export function entryVersion(e: LedgerEntry): string {
	const { ref, kind, id, at, after, from, data } = e;
	return createHash("sha256").update(canonicalJson({ ref, kind, id, at, after, from, data })).digest("hex");
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		v !== null && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: v,
	);
}

/** The ledger file an entry of `kind` with `data` belongs to; throws `LedgerError("kind")` when it has none. */
export function fileFor(kind: LedgerKind, data: unknown): string {
	if (kind === "counter") return "change.yaml";
	if (kind === "unit-start" || kind === "receipt") return `units/${unitOf(kind, data)}.yaml`;
	const file = JSONL_FILES[kind];
	if (!file) throw new LedgerError("kind", `\`${kind}\` is not a ledger kind`);
	return file;
}

function unitOf(kind: LedgerKind, data: unknown): string {
	const unit = isObject(data) ? data.unit : undefined;
	if (typeof unit !== "string" || !UNIT_NAME.test(unit)) {
		throw new LedgerError("kind", `a \`${kind}\` entry needs \`data.unit\` naming a unit, got ${JSON.stringify(unit) ?? "nothing"}`);
	}
	return unit;
}

/**
 * The text that appends `entries` to a file whose current content is `existing`. Throws
 * `LedgerError("git")` when a YAML file would not read back as its old entries plus `entries`.
 */
export function appendText(path: string, existing: string, entries: LedgerEntry[]): string {
	const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
	if (isJsonl(path)) return prefix + entries.map((e) => `${JSON.stringify(e)}\n`).join("");
	const text = prefix + stringify(entries, { aliasDuplicateObjects: false });
	const before = yamlSequenceLength(existing);
	if (before === undefined || yamlSequenceLength(text) !== before + entries.length) {
		throw new LedgerError("git", `refusing to append to \`${path}\`: it is not a readable YAML sequence of entries`);
	}
	return text;
}

/** Throws `LedgerError("kind")` when `entry` would be skipped by a read of its own file. */
export function assertEntry(entry: LedgerEntry): void {
	const problem = entryProblem(entry);
	if (problem) throw new LedgerError("kind", `invalid ledger entry ${JSON.stringify(entry.ref) ?? "(no ref)"}: ${problem}`);
	fileFor(entry.kind, entry.data);
}

function yamlSequenceLength(text: string): number | undefined {
	try {
		const doc: unknown = parse(text);
		if (doc === null || doc === undefined) return 0;
		return Array.isArray(doc) ? doc.length : undefined;
	} catch {
		return undefined;
	}
}

/** The entries of one ledger file in file order, with one warning per entry skipped. */
export function parseFile(path: string, text: string): { entries: LedgerEntry[]; warnings: string[]; skippedFile: boolean } {
	const items = isJsonl(path) ? parseJsonl(path, text) : parseYamlSequence(path, text);
	const entries: LedgerEntry[] = [];
	const warnings = [...items.warnings];
	for (const { value, where } of items.values) {
		const problem = entryProblem(value) ?? kindInFileProblem(path, value as LedgerEntry);
		if (problem) warnings.push(`${where}: skipped entry: ${problem}`);
		else entries.push(value as LedgerEntry);
	}
	return { entries, warnings, skippedFile: items.skippedFile === true };
}

/** True when `path` names a file that may hold entries. */
export function isEntryFile(path: string): boolean {
	return Object.values(JSONL_FILES).includes(path) || path === "change.yaml" || /^units\/[^/]+\.yaml$/.test(path);
}

type ParsedItems = { values: { value: unknown; where: string }[]; warnings: string[]; skippedFile?: true };

function parseJsonl(path: string, text: string): ParsedItems {
	const result: ParsedItems = { values: [], warnings: [] };
	text.split("\n").forEach((line, index) => {
		if (line.trim() === "") return;
		const where = `${path}:${index + 1}`;
		try {
			result.values.push({ value: JSON.parse(line), where });
		} catch {
			result.warnings.push(`${where}: skipped entry: not valid JSON`);
		}
	});
	return result;
}

function parseYamlSequence(path: string, text: string): ParsedItems {
	let doc: unknown;
	try {
		doc = parse(text);
	} catch {
		return { values: [], warnings: [`${path}: skipped file: not valid YAML`], skippedFile: true };
	}
	if (doc === null || doc === undefined) return { values: [], warnings: [] };
	if (!Array.isArray(doc)) return { values: [], warnings: [`${path}: skipped file: not a YAML sequence`], skippedFile: true };
	return { values: doc.map((value, index) => ({ value, where: `${path}[${index}]` })), warnings: [] };
}

/** Why `value` is not a well-formed entry, or undefined when it is. */
function entryProblem(value: unknown): string | undefined {
	if (!isObject(value)) return "not an object";
	if (typeof value.ref !== "string" || !REF_PATTERN.test(value.ref)) return "missing or malformed `ref`";
	if (typeof value.kind !== "string" || !isLedgerKind(value.kind)) return "missing or unknown `kind`";
	if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) return "missing or malformed `id`";
	if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) return "missing or invalid `seq`";
	if (typeof value.at !== "string" || value.at === "") return "missing `at`";
	if (value.after !== undefined && typeof value.after !== "string") return "invalid `after`";
	if (value.from !== undefined && typeof value.from !== "string") return "invalid `from`";
	// `undefined` data is dropped by both encoders, so the entry would read back without `data`.
	if (!Object.hasOwn(value, "data") || value.data === undefined) return "missing `data`";
	return dataProblem(value.data);
}

/** Every payload is an object; `items` and `findings`, when present, are arrays (consumers dereference them). */
function dataProblem(data: unknown): string | undefined {
	if (!isObject(data)) return "`data` is not an object";
	if (data.items !== undefined && !Array.isArray(data.items)) return "`data.items` is not an array";
	if (data.findings !== undefined && !Array.isArray(data.findings)) return "`data.findings` is not an array";
	return undefined;
}

function kindInFileProblem(path: string, { kind, data }: LedgerEntry): string | undefined {
	try {
		if (fileFor(kind, data) === path) return undefined;
	} catch {
		// An entry without a valid unit cannot belong to any unit file.
	}
	return `kind \`${kind}\` is not allowed in this file`;
}

function isJsonl(path: string): boolean {
	return path.endsWith(".jsonl");
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
