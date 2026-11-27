// Request lifecycle facts (design D2), derived purely from own marked comments:
// a `request` comment with no `answer` is pending, an `answer` with no result
// comment is applying, and a result comment carrying `request: <id>` completes it.

import { gateDigest } from "../engine/locks.ts";
import { type MarkedComment, writeMarked } from "../forge/markers.ts";
import { neutralise } from "./briefing.ts";
import {
	ANSWER_KIND,
	type Answered,
	isSubject,
	REQUEST_KIND,
	type RequestKind,
	type RequestMode,
	type RequestOption,
	type RequestRecord,
	type AmendSnapshot,
	type Briefing,
	type DecideSnapshot,
	type GateSnapshot,
	type QuestionSnapshot,
	type RequestSnapshot,
	type StuckSnapshot,
	type Subject,
} from "./approver.ts";

/**
 * The `answer` comment data: the full request, the human's answer and the validation verdict. A superseded `reason`
 * is already wrapped as untrusted where it was built when `reason_wrapped` is set; an answer without the field is
 * legacy and its whole reason is wrapped when shown.
 */
export type AnswerData = { request: RequestRecord; answer: Answered; verdict: "valid" | "superseded"; reason?: string; reason_wrapped?: true };

/** The snapshot of a request with its kind, derived from the subject prefix. */
export type TypedSnapshot =
	| { kind: "gate"; snapshot: GateSnapshot }
	| { kind: "amend"; snapshot: AmendSnapshot }
	| { kind: "question"; snapshot: QuestionSnapshot }
	| { kind: "stuck"; snapshot: StuckSnapshot }
	| { kind: "decide"; snapshot: DecideSnapshot };

/** A typed view of the stored snapshot (design D5); the stored yaml is not validated. */
export function snapshotOf(record: RequestRecord): TypedSnapshot {
	const kind = record.subject.slice(0, record.subject.indexOf(":")) as TypedSnapshot["kind"];
	return { kind, snapshot: record.snapshot } as TypedSnapshot;
}

export type PendingRequest = { id: string; subject: Subject; kind: RequestKind; mode: RequestMode; createdAt: string; data: RequestRecord };
export type AppliedAnswer = { id: string; subject: Subject; record: AnswerData };
export type RequestsState = { pending: PendingRequest[]; applying: AppliedAnswer[] };

export type PrepareInput = {
	kind: RequestKind;
	subject: Subject;
	mode: RequestMode;
	options?: RequestOption[];
	briefing?: Briefing;
	head: string;
	body: string;
	snapshot: RequestSnapshot;
	summary: string;
	now: Date;
};

/** Kinds of the comment that completes a request; each carries `request: <id>`. */
const RESULT_KINDS = new Set(["gate", "amendment", "question", "stuck", "decision"]);
const ID_SEPARATOR = ".";
const BASE36 = 36;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `<subject-token>.<base36 epoch ms>`; the token is the subject with every non-alphanumeric run as `-`. */
export function newRequestId(subject: Subject, now: Date): string {
	const token = subject.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
	return `${token}${ID_SEPARATOR}${now.getTime().toString(BASE36)}`;
}

/** The durable request envelope, built before any adapter runs; a gate also records the gate digest. */
export function prepareRequest(input: PrepareInput): RequestRecord {
	const record: RequestRecord = {
		id: newRequestId(input.subject, input.now),
		kind: input.kind,
		subject: input.subject,
		mode: input.mode,
		head_sha: input.head,
		snapshot: input.snapshot,
		summary: neutralise(input.summary),
	};
	if (input.options !== undefined) record.options = input.options;
	if (input.briefing !== undefined) record.briefing = input.briefing;
	if (input.kind === "gate") record.gate_digest = gateDigest(input.body);
	return record;
}

/** The forge `request` comment: the record without its id as yaml, then the plain-text instructions. */
export function requestComment(id: string, data: RequestRecord, plainText: string): string {
	const { id: _id, ...yaml } = data;
	return `${writeMarked(REQUEST_KIND, id, yaml)}\n\n${plainText}`;
}

/** The `answer` comment, id = request id. */
export function answerComment(id: string, data: AnswerData): string {
	return writeMarked(ANSWER_KIND, id, data);
}

const BASE36_SUFFIX = /^[0-9a-z]+$/;

/** When the request was made, from the base36 ms suffix of its id; "" when the suffix is missing or no valid date. */
function createdAtOf(id: string): string {
	const separator = id.lastIndexOf(ID_SEPARATOR);
	const suffix = separator === -1 ? "" : id.slice(separator + 1);
	if (!BASE36_SUFFIX.test(suffix)) return "";
	const date = new Date(Number.parseInt(suffix, BASE36));
	return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function asRequestRecord(m: MarkedComment): RequestRecord | undefined {
	const d = m.data;
	if (!isObject(d) || typeof d.subject !== "string" || !isSubject(d.subject) || typeof d.kind !== "string" || typeof d.mode !== "string") return undefined;
	return { ...(d as Omit<RequestRecord, "id">), id: m.id };
}

function asAnswerData(m: MarkedComment): AnswerData | undefined {
	const d = m.data;
	if (!isObject(d) || !isObject(d.request) || typeof d.request.subject !== "string" || !isSubject(d.request.subject) || !isObject(d.answer)) return undefined;
	return d as AnswerData;
}

function completedIds(marked: MarkedComment[]): Set<string> {
	const ids = new Set<string>();
	for (const m of marked) {
		if (RESULT_KINDS.has(m.kind) && isObject(m.data) && typeof m.data.request === "string") ids.add(m.data.request);
	}
	return ids;
}

function answers(marked: MarkedComment[]): Map<string, AnswerData> {
	const found = new Map<string, AnswerData>();
	for (const m of marked) {
		const data = m.kind === ANSWER_KIND ? asAnswerData(m) : undefined;
		if (data) found.set(m.id, data);
	}
	return found;
}

/** Every own request comment, whatever its state, in comment order, with the comment id it lives in. */
export function allRequests(marked: MarkedComment[]): (PendingRequest & { commentId: string })[] {
	const out: (PendingRequest & { commentId: string })[] = [];
	for (const m of marked) {
		const data = m.kind === REQUEST_KIND ? asRequestRecord(m) : undefined;
		if (data) out.push({ id: m.id, subject: data.subject, kind: data.kind, mode: data.mode, createdAt: createdAtOf(m.id), data, commentId: m.ref });
	}
	return out;
}

/** Pending and applying requests, in comment order; completed requests are dropped. */
export function readRequests(marked: MarkedComment[]): RequestsState {
	const completed = completedIds(marked);
	const answered = answers(marked);
	const pending: PendingRequest[] = allRequests(marked)
		.filter((r) => !answered.has(r.id) && !completed.has(r.id))
		.map(({ commentId: _commentId, ...r }) => r);
	const applying: AppliedAnswer[] = [];
	for (const [id, record] of answered) {
		if (!completed.has(id)) applying.push({ id, subject: record.request.subject, record });
	}
	return { pending, applying };
}

/** Pending then applying requests, as `{ id, subject }`, in that order; a request of either kind is open. */
export function openRequests(requests: RequestsState): { id: string; subject: Subject }[] {
	return [...requests.pending, ...requests.applying].map(({ id, subject }) => ({ id, subject }));
}

/** The id of the open (pending or applying) request for `subject`, if any. */
export function openRequestFor(requests: RequestsState, subject: Subject): string | undefined {
	return openRequests(requests).find((r) => r.subject === subject)?.id;
}

/** The first own comment that closes a request: its `answer` comment, else its result comment. */
export type Closer = { commentId: string; answerCommentId?: string };

/** The closer of every answered or completed request, keyed by request id. */
export function closers(marked: MarkedComment[]): Map<string, Closer> {
	const out = new Map<string, Closer>();
	for (const m of marked) {
		if (!isObject(m.data)) continue;
		const id = m.kind === ANSWER_KIND ? m.id : RESULT_KINDS.has(m.kind) && typeof m.data.request === "string" ? m.data.request : undefined;
		if (id === undefined || out.has(id)) continue;
		const answer = m.kind === ANSWER_KIND && isObject(m.data.answer) && isObject(m.data.answer.answerComment) ? m.data.answer.answerComment.id : undefined;
		out.set(id, typeof answer === "string" ? { commentId: m.ref, answerCommentId: answer } : { commentId: m.ref });
	}
	return out;
}
