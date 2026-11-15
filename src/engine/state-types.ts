// Plain data shapes shared by the snapshot reader, the checks runner and the
// pure next-step decision.

import type { Change, Question } from "../core/change.ts";
import type { Result } from "../core/result.ts";
import type { MarkedComment } from "../forge/markers.ts";
import type { RequestsState } from "../interaction/requests.ts";
import type { IterationState } from "./iterations.ts";
import type { LockState } from "./locks.ts";

/** A check Result tagged with the registered name of the check that produced it. */
export type CheckResult = Result & { check: string };

export type SectionName = "Capabilities" | "Proposal" | "Design" | "Units";

export type PhaseState = { kind: "ok"; id: string } | { kind: "missing" } | { kind: "ambiguous"; ids: string[] };

export type ChangeState = {
	issue: { number: number; title: string; labels: string[] };
	phase: PhaseState;
	change: Change;
	sections: Record<SectionName, boolean>;
	counters: Record<string, number>;
	/** Ids (`<phase>.<skill>`) of own `skill-note` comments. */
	skillNotes: string[];
	/** Ids of own `incomplete` comments. */
	incomplete: string[];
	/** `specsChanged` is undefined without `Base`, else whether `git diff <Base>..HEAD -- specs/` is non-empty. */
	git: { branch: string; head: string; dirty: boolean; specsChanged: boolean | undefined };
	checks: CheckResult[];
	stale: boolean;
	readOnly: boolean;
	warnings: string[];
	/** Own marked comments of the issue, in comment order. */
	marked: MarkedComment[];
	requests: RequestsState;
	lock: LockState;
	iterations: IterationState;
	/** Warnings from the last approval poll about ignored command comments. */
	commandWarnings: string[];
};

export type NextStep = {
	phase: string | undefined;
	required: string[];
	optional: string[];
	redirects: string[];
	checks: CheckResult[];
	blockingQuestions: Question[];
	counters: { name: string; value: number; cap?: number }[];
	activeUnits: string[];
	blockedUnits: { id: string; waitingOn: string[] }[];
	incomplete: string[];
	advance?: string;
	next: string;
};
