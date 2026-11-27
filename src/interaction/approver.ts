// The approver contract: every human decision (gate, amendment, question,
// stuck report, rule `ask`) reaches a human through an `Approver`. Answers come
// only from the human through an adapter, never from a tool parameter.

import type { DecisionRecord } from "../decide/records.ts";
import { registerKind } from "../forge/markers.ts";
import type { DialogFactory, DialogOutcome } from "./dialog/types.ts";

/** Ordered list of the adapter names `interaction.adapter` accepts. */
export const ADAPTER_NAMES = ["in-session", "forge"] as const;
export type AdapterName = (typeof ADAPTER_NAMES)[number];

export type RequestKind = "gate" | "question" | "stuck";

/** `gate:<phase|name>` | `amend:<n>` | `question:Q<n>` | `stuck:S<n>` | `decide:<point>.<subject>`. */
export type Subject = `gate:${string}` | `amend:${number}` | `question:Q${number}` | `stuck:S${number}` | `decide:${string}`;

const SUBJECT_PATTERNS = [/^gate:.+$/, /^amend:\d+$/, /^question:Q\d+$/, /^stuck:S\d+$/, /^decide:.+$/];

/** Whether `s` is a subject LS-05 writes; forge text is parsed with this before it is trusted as a `Subject`. */
export function isSubject(s: string): s is Subject {
	return SUBJECT_PATTERNS.some((pattern) => pattern.test(s));
}

export type RequestMode = "blocking" | "async";
export type QuestionClass = "blocking" | "non-blocking";
export type Outcome = "approved" | "approved_with_notes" | "changes_requested" | "dismissed";
export type Difficulty = "low" | "medium" | "high";

export interface RequestOption {
	id: string;
	label: string;
	description?: string;
}

/** Advisory context shown with a request; text is neutralised before it is stored. */
export interface Briefing {
	summary: string;
	watch?: string[];
	recommended?: string;
	rationale?: string;
	author: "agent" | "rule";
}

export interface GateSnapshot {
	target: string;
	failingWaivable: string[];
	/** Keys (`<commentId>:<index>`) of the subagent findings the gate payload listed. */
	findings?: string[];
	/** The proposer's payload of a named gate with a proposer (initiative entries, new-dependency drafts). */
	drafts?: unknown;
	/** Plan gate only: requirement id to content digest at the request's `head_sha`, the cascade baseline. */
	requirements?: Record<string, string>;
	/** Plan gate only: the capabilities `requirements` scanned. */
	requirement_scope?: string[];
}

export interface AmendSnapshot {
	action: "edit" | "add" | "drop";
	unit: string;
	oldDigest?: string;
	oldDone?: boolean;
	lines?: string[];
	records: DecisionRecord[];
}

export interface QuestionSnapshot {
	id: string;
	text: string;
}

export interface StuckSnapshot {
	id: string;
}

export interface DecideSnapshot {
	point: string;
	subject: string;
	facts: unknown;
	digest?: string;
	/** Set by `unit_amend`: the answer becomes effective only when the amendment is approved. */
	proposal?: true;
	/** Point `behavior-change`: the item's files, copied to the record's top-level `files`. */
	files?: string[];
}

export type RequestSnapshot = GateSnapshot | AmendSnapshot | QuestionSnapshot | StuckSnapshot | DecideSnapshot;

/** What the forge persists as the `request` comment and both adapters carry into the `answer` comment. */
export interface RequestRecord {
	id: string;
	kind: RequestKind;
	subject: Subject;
	mode: RequestMode;
	options?: RequestOption[];
	briefing?: Briefing;
	head_sha: string;
	gate_digest?: string;
	snapshot: RequestSnapshot;
	summary: string;
}

export interface ApprovalRequest {
	id: string;
	kind: RequestKind;
	subject: Subject;
	record: RequestRecord;
	change: number;
	phase: string;
	summary: string;
	links: string[];
	files: string[];
	options?: RequestOption[];
	briefing?: Briefing;
	mode: RequestMode;
	overridable?: { units: string[]; current?: Record<string, { difficulty?: Difficulty; tags: string[] }> };
	question?: { id: string; class: QuestionClass };
}

export interface Override {
	unit: string;
	difficulty?: Difficulty;
	tags?: string[];
}

/** For questions, `answer` holds the answer text; an answered question is `approved`, a dismissed one `dismissed`. */
export interface Answered {
	status: "answered";
	outcome: Outcome;
	choice?: string;
	notes: string;
	answer?: string;
	by: string;
	at: string;
	adapter: AdapterName;
	questionClass?: QuestionClass;
	overrides?: Override[];
	answerComment?: { id: string; author: string; updatedAt: string };
}

export interface Pending {
	status: "pending";
	requestId: string;
}

/** In-session returns this when the human chooses "answer later". */
export interface Deferred {
	status: "deferred";
	questionClass: "non-blocking";
}

export interface Approver {
	readonly name: AdapterName;
	available(): boolean;
	request(r: ApprovalRequest): Promise<Answered | Pending | Deferred>;
}

/** The subset of `ctx.ui` plus `ctx.hasUI` the in-session adapter uses. */
export interface ApproverUI {
	hasUI: boolean;
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	/** One custom dialog per request; set only where the host can draw it. `undefined` = drew nothing (fall back). */
	dialog?: (factory: DialogFactory<DialogOutcome>) => Promise<DialogOutcome | undefined>;
}

/** Marker kind of a pending forge request: id `<subject-token>.<base36 ms>`. */
export const REQUEST_KIND = "request";
/** Marker kind of a validated answer: id = request id. */
export const ANSWER_KIND = "answer";
/** Marker kind of an applied `/livespec class` command: id = the command comment id. */
export const CLASS_KIND = "class";
registerKind(REQUEST_KIND);
registerKind(ANSWER_KIND);
registerKind(CLASS_KIND);
