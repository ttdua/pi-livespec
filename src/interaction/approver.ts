// The approver contract: every human decision (gate, amendment, question,
// stuck report, rule `ask`) reaches a human through an `Approver`. Answers come
// only from the human through an adapter, never from a tool parameter.

import type { DecisionRecord } from "../decide/records.ts";
import { registerKind } from "../forge/markers.ts";

/** Ordered list of the adapter names `interaction.adapter` accepts. */
export const ADAPTER_NAMES = ["in-session", "forge"] as const;
export type AdapterName = (typeof ADAPTER_NAMES)[number];

export type RequestKind = "gate" | "question" | "stuck";

/** `gate:<phase|name>` | `amend:<n>` | `question:Q<n>` | `stuck:S<n>` | `decide:<point>.<subject>`. */
export type Subject = string;

export type RequestMode = "blocking" | "async";
export type QuestionClass = "blocking" | "non-blocking";
export type Outcome = "approved" | "approved_with_notes" | "changes_requested" | "dismissed";
export type Difficulty = "low" | "medium" | "high";

export interface RequestOption {
	id: string;
	label: string;
}

export interface GateSnapshot {
	target: string;
	digests: Record<string, string>;
	failingWaivable: string[];
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
	requirements: string[];
}

export interface StuckSnapshot {
	id: string;
}

export interface DecideSnapshot {
	point: string;
	subject: string;
	facts: unknown;
}

export type RequestSnapshot = GateSnapshot | AmendSnapshot | QuestionSnapshot | StuckSnapshot | DecideSnapshot;

/** What the forge persists as the `request` comment and both adapters carry into the `answer` comment. */
export interface RequestRecord {
	id: string;
	kind: RequestKind;
	subject: Subject;
	mode: RequestMode;
	options?: RequestOption[];
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
	mode: RequestMode;
	overridable?: { units: string[] };
	question?: { id: string; class: QuestionClass; requirements: string[] };
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
	changesRequirement?: string;
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
	poll(requestId: string): Promise<Answered | { status: "pending" }>;
}

/** The subset of `ctx.ui` plus `ctx.hasUI` the in-session adapter uses. */
export interface ApproverUI {
	hasUI: boolean;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

/** Marker kind of a pending forge request: id `<subject-token>.<base36 ms>`. */
export const REQUEST_KIND = "request";
/** Marker kind of a validated answer: id = request id. */
export const ANSWER_KIND = "answer";
registerKind(REQUEST_KIND);
registerKind(ANSWER_KIND);
