// Evidence records: the `unit-start` and `receipt` marked comments, their ids and their parsers.

import { type MarkedComment, registerKind, writeMarked } from "../forge/markers.ts";

const START_KIND = "unit-start";
const RECEIPT_KIND = "receipt";

registerKind(START_KIND);

export type StartData = {
	unit: string;
	digest: string;
	verify: string;
	pre: { sha: string; exit?: number; verdict?: "red" | "green"; output?: string };
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
	/** The id of the matching `unit-start` comment. */
	start: string;
	pending_commit?: string;
};

/** `index` is the record's position in comment order. */
type Located = { id: string; commentId: string; index: number };
export type StartRecord = StartData & Located;
export type ReceiptRecord = ReceiptData & Located;

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optional = (o: Raw, key: string, check: (v: unknown) => boolean): boolean => !Object.hasOwn(o, key) || check(o[key]);

const hasUnitFields = (d: Raw): boolean => isString(d.unit) && isString(d.digest) && isString(d.verify);
const isRun = (v: unknown): boolean => isObject(v) && isString(v.sha) && isNumber(v.exit);

function isStartPre(v: unknown): boolean {
	if (!isObject(v) || !isString(v.sha)) return false;
	return optional(v, "exit", isNumber) && optional(v, "verdict", (x) => x === "red" || x === "green") && optional(v, "output", isString);
}

function isStartData(d: unknown): d is StartData {
	if (!isObject(d) || !hasUnitFields(d) || !isStartPre(d.pre)) return false;
	return optional(d, "pending", (x) => x === true) && optional(d, "refactor", (x) => x === true);
}

function isReceiptData(d: unknown): d is ReceiptData {
	if (!isObject(d) || !hasUnitFields(d) || !isRun(d.pre) || !isRun(d.post)) return false;
	return isString(d.output) && isString(d.start) && optional(d, "pending_commit", isString);
}

/** The `unit-start` comment body. */
export function startComment(id: string, d: StartData): string {
	return writeMarked(START_KIND, id, d);
}

/** The `receipt` comment body. */
export function receiptComment(id: string, d: ReceiptData): string {
	return writeMarked(RECEIPT_KIND, id, d);
}

/** An evidence id `<unit>.<base36 ms>`. */
export function newEvidenceId(unit: string, now: Date): string {
	return `${unit}.${now.getTime().toString(36)}`;
}

function located<T>(m: MarkedComment, index: number, kind: string, valid: (d: unknown) => d is T): (T & Located) | undefined {
	return m.kind === kind && valid(m.data) ? { ...m.data, id: m.id, commentId: m.commentId, index } : undefined;
}

/** The start record of comment `m` at comment index `index`, when it is a well-formed `unit-start`. */
export function asStartRecord(m: MarkedComment, index: number): StartRecord | undefined {
	return located(m, index, START_KIND, isStartData);
}

/** The receipt record of comment `m` at comment index `index`, when it is a well-formed `receipt`. */
export function asReceiptRecord(m: MarkedComment, index: number): ReceiptRecord | undefined {
	return located(m, index, RECEIPT_KIND, isReceiptData);
}

export function readStarts(marked: MarkedComment[]): StartRecord[] {
	return marked.flatMap((m, index) => asStartRecord(m, index) ?? []);
}

export function readReceipts(marked: MarkedComment[]): ReceiptRecord[] {
	return marked.flatMap((m, index) => asReceiptRecord(m, index) ?? []);
}
