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

export type LedgerRead = { tip?: string; entries: LedgerEntry[]; warnings: string[] };

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

/** The text that appends `entries` to a file whose current content is `existing`. */
export function appendText(path: string, existing: string, entries: LedgerEntry[]): string {
	const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
	const added = isJsonl(path) ? entries.map((e) => `${JSON.stringify(e)}\n`).join("") : stringify(entries);
	return prefix + added;
}

/** The entries of one ledger file in file order, with one warning per entry skipped. */
export function parseFile(path: string, text: string): { entries: LedgerEntry[]; warnings: string[] } {
	const items = isJsonl(path) ? parseJsonl(path, text) : parseYamlSequence(path, text);
	const entries: LedgerEntry[] = [];
	const warnings = [...items.warnings];
	for (const { value, where } of items.values) {
		const problem = entryProblem(path, value);
		if (problem) warnings.push(`${where}: skipped entry: ${problem}`);
		else entries.push(value as LedgerEntry);
	}
	return { entries, warnings };
}

/** True when `path` names a file that may hold entries. */
export function isEntryFile(path: string): boolean {
	return Object.values(JSONL_FILES).includes(path) || path === "change.yaml" || /^units\/[^/]+\.yaml$/.test(path);
}

type ParsedItems = { values: { value: unknown; where: string }[]; warnings: string[] };

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
		return { values: [], warnings: [`${path}: skipped file: not valid YAML`] };
	}
	if (doc === null || doc === undefined) return { values: [], warnings: [] };
	if (!Array.isArray(doc)) return { values: [], warnings: [`${path}: skipped file: not a YAML sequence`] };
	return { values: doc.map((value, index) => ({ value, where: `${path}[${index}]` })), warnings: [] };
}

/** Why `value` is not a valid entry of the file at `path`, or undefined when it is. */
function entryProblem(path: string, value: unknown): string | undefined {
	if (!isObject(value)) return "not an object";
	if (typeof value.ref !== "string" || !REF_PATTERN.test(value.ref)) return "missing or malformed `ref`";
	if (typeof value.kind !== "string" || !isLedgerKind(value.kind)) return "missing or unknown `kind`";
	if (typeof value.id !== "string" || value.id === "") return "missing `id`";
	if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) return "missing or invalid `seq`";
	if (typeof value.at !== "string" || value.at === "") return "missing `at`";
	if (value.after !== undefined && typeof value.after !== "string") return "invalid `after`";
	if (value.from !== undefined && typeof value.from !== "string") return "invalid `from`";
	if (!Object.hasOwn(value, "data")) return "missing `data`";
	return kindInFileProblem(path, value.kind, value.data);
}

function kindInFileProblem(path: string, kind: LedgerKind, data: unknown): string | undefined {
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
