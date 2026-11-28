// Evidence records: the `unit-start`, `receipt` and `rebuild` marked comments, their ids and their parsers.

import { type MarkedComment, registerKind, writeMarked } from "../forge/markers.ts";
import type { AppendInput } from "../ledger/entry.ts";

const START_KIND = "unit-start" as const;
const RECEIPT_KIND = "receipt" as const;
const REBUILD_KIND = "rebuild";

registerKind(START_KIND);
registerKind(REBUILD_KIND);

/** `rebuild`: a review-routed rebuild started green; `resumed`: a unit of a resumed park started green. */
export type StartVerdict = "red" | "green" | "rebuild" | "resumed";
const START_VERDICTS: ReadonlySet<unknown> = new Set<StartVerdict>(["red", "green", "rebuild", "resumed"]);

export type StartData = {
	unit: string;
	digest: string;
	verify: string;
	pre: { sha: string; exit?: number; verdict?: StartVerdict; output?: string };
	pending?: true;
	refactor?: true;
};

export type ReceiptData = {
	unit: string;
	digest: string;
	verify: string;
	pre: { sha: string; exit: number };
	post: { sha: string; exit: number };
	output: string;
	/** The `ref` of the matching `unit-start` entry. */
	start: string;
	pending_commit?: string;
};

/** A review-routed finding that sends a built unit back to be rebuilt: id `rebuild.<unit>.<round>`. */
export type RebuildData = { unit: string; round: number; finding: string };

/** `index` is the record's position in comment order. */
type Located = { id: string; commentId: string; index: number };
export type StartRecord = StartData & Located;
export type ReceiptRecord = ReceiptData & Located;
export type RebuildRecord = RebuildData & Located;

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optional = (o: Raw, key: string, check: (v: unknown) => boolean): boolean => !Object.hasOwn(o, key) || check(o[key]);

const hasUnitFields = (d: Raw): boolean => isString(d.unit) && isString(d.digest) && isString(d.verify);
const isRun = (v: unknown): boolean => isObject(v) && isString(v.sha) && isNumber(v.exit);

function isStartPre(v: unknown): boolean {
	if (!isObject(v) || !isString(v.sha)) return false;
	return optional(v, "exit", isNumber) && optional(v, "verdict", (x) => START_VERDICTS.has(x)) && optional(v, "output", isString);
}

function isStartData(d: unknown): d is StartData {
	if (!isObject(d) || !hasUnitFields(d) || !isStartPre(d.pre)) return false;
	return optional(d, "pending", (x) => x === true) && optional(d, "refactor", (x) => x === true);
}

function isReceiptData(d: unknown): d is ReceiptData {
	if (!isObject(d) || !hasUnitFields(d) || !isRun(d.pre) || !isRun(d.post)) return false;
	return isString(d.output) && isString(d.start) && optional(d, "pending_commit", isString);
}

/** The `unit-start` ledger entry input. */
export function startComment(id: string, d: StartData): AppendInput {
	return { kind: START_KIND, id, data: d };
}

/** The `receipt` ledger entry input. */
export function receiptComment(id: string, d: ReceiptData): AppendInput {
	return { kind: RECEIPT_KIND, id, data: d };
}

/** The `rebuild` comment body. */
export function rebuildComment(data: RebuildData): string {
	return writeMarked(REBUILD_KIND, `rebuild.${data.unit}.${data.round}`, data);
}

/** An evidence id `<unit>.<base36 ms>`. */
export function newEvidenceId(unit: string, now: Date): string {
	return `${unit}.${now.getTime().toString(36)}`;
}

function located<T>(m: MarkedComment, index: number, kind: string, valid: (d: unknown) => d is T): (T & Located) | undefined {
	return m.kind === kind && valid(m.data) ? { ...m.data, id: m.id, commentId: m.ref, index } : undefined;
}

/** The start record of comment `m` at comment index `index`, when it is a well-formed `unit-start`. */
export function asStartRecord(m: MarkedComment, index: number): StartRecord | undefined {
	return located(m, index, START_KIND, isStartData);
}

/** The receipt record of comment `m` at comment index `index`, when it is a well-formed `receipt`. */
export function asReceiptRecord(m: MarkedComment, index: number): ReceiptRecord | undefined {
	return located(m, index, RECEIPT_KIND, isReceiptData);
}

function isRebuildData(d: unknown): d is RebuildData {
	return isObject(d) && isString(d.unit) && isNumber(d.round) && isString(d.finding);
}

/** The rebuild record of comment `m` at comment index `index`, when it is a well-formed `rebuild`. */
export function asRebuildRecord(m: MarkedComment, index: number): RebuildRecord | undefined {
	return located(m, index, REBUILD_KIND, isRebuildData);
}

export function readStarts(marked: MarkedComment[]): StartRecord[] {
	return marked.flatMap((m, index) => asStartRecord(m, index) ?? []);
}

export function readReceipts(marked: MarkedComment[]): ReceiptRecord[] {
	return marked.flatMap((m, index) => asReceiptRecord(m, index) ?? []);
}
