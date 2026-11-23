// Plain data shapes shared by the snapshot reader, the checks runner and the
// pure next-step decision.

import type { Change, Question } from "../core/change.ts";
import type { Result } from "../core/result.ts";
import type { DurableFacts } from "../ship/durable-docs.ts";
import type { UnitEvidence } from "../evidence/unit-state.ts";
import type { MarkedComment } from "../forge/markers.ts";
import type { IssueState } from "../forge/types.ts";
import type { AdapterName } from "../interaction/approver.ts";
import type { RequestsState } from "../interaction/requests.ts";
import type { ReviewSubject, Role } from "../subagents/roles.ts";
import type { LaneRecord } from "../subagents/state.ts";
import type { UnfamiliarFacts } from "../subagents/unfamiliar.ts";
import type { DepFact, ParkedUnit } from "./deps-facts.ts";
import type { IterationState } from "./iterations.ts";
import type { LockState } from "./locks.ts";
import type { ParkedCore } from "./parked.ts";

/** A check Result tagged with the registered name of the check that produced it. */
export type CheckResult = Result & { check: string };

export type SectionName = "Capabilities" | "Proposal" | "Design" | "Units";

export type PhaseState = { kind: "ok"; id: string } | { kind: "missing" } | { kind: "ambiguous"; ids: string[] };

export type ChangeState = {
	issue: { number: number; title: string; labels: string[]; state: IssueState; url?: string };
	phase: PhaseState;
	change: Change;
	sections: Record<SectionName, boolean>;
	counters: Record<string, number>;
	/** Ids (`<phase>.<skill>`) of own `skill-note` comments. */
	skillNotes: string[];
	/** Items of the latest own `incomplete` comment; empty when it is cleared or absent. */
	incomplete: string[];
	/** `specsChanged` is undefined without `Base`, else whether `git diff <Base>..HEAD -- specs/` is non-empty. */
	git: { branch: string; head: string; dirty: boolean; specsChanged: boolean | undefined };
	checks: CheckResult[];
	/** The pull request the `PR:` line names; absent without one, or when it cannot be read. */
	pr?: { number: number; state: "open" | "closed"; merged: boolean; mergedAt?: string; pushedHead?: string };
	/**
	 * Git-dependent ship facts, filled at refresh in `src/hooks/card-input.ts` (`nextStep` does no git work).
	 * `reviewed`: HEAD is reviewed against the review gate's SHA; `needsShipGate`: `change_push` would need a ship
	 * gate at HEAD; `gatesAtHead`: per head-bound gate, false when its approval no longer holds at HEAD.
	 */
	ship?: {
		docsRowsNeeded?: boolean;
		durableFacts?: DurableFacts;
		reviewed?: boolean;
		needsShipGate?: boolean;
		gatesAtHead?: { review: boolean; ship: boolean };
	};
	stale: boolean;
	readOnly: boolean;
	warnings: string[];
	/** Own marked comments of the issue, in comment order. */
	marked: MarkedComment[];
	requests: RequestsState;
	lock: LockState;
	iterations: IterationState;
	/** The latest own `parked` record while the change is parked, from comments only (design D3a). */
	parkedCore?: ParkedCore;
	/** The parked core plus the states of the dependencies it waits for; filled at refresh. */
	parked?: { waitsFor: DepFact[]; units: ParkedUnit[]; at: string };
	/** Readiness facts of the change's dependencies and initiative; filled at refresh (design D3). */
	deps?: {
		items: DepFact[];
		initiative?: { number: number; checked: number; total: number; ready: { number: number; name: string }[] };
		overlap: { number: number; title: string; capabilities: string[] }[];
		integrationAhead?: boolean;
		siblingMerged?: boolean;
		split?: "propose" | "single";
	};
	/** Warnings from the last approval poll about ignored command comments. */
	commandWarnings: string[];
	/** Started, receipted and blocked units, derived from own `unit-start`, `receipt` and `progress` comments. */
	evidence: UnitEvidence;
	/** Executor availability, context usage, open lanes and the unanswered child question; filled at refresh. */
	subagents: {
		executor: { ok: boolean; missing: string[] };
		contextPercent?: number;
		turnsCompleted: number;
		lanes: Record<string, LaneRecord>;
		/** HEAD of each open lane worktree that exists, read at refresh. */
		laneHeads?: Record<string, string>;
		/** Units whose latest merged lane head is the second parent of the merge commit at HEAD, read at refresh. */
		mergedLaneHeads?: Record<string, string>;
		/** The user's `lanes` limit, copied at refresh; the default when absent. */
		laneLimit?: number;
		/** The `unfamiliar-code` fact, read from the living specs at refresh. */
		unfamiliar: UnfamiliarFacts;
		pending?: { unit?: string; agentId: string; question: string };
	};
};

/** What one precedence rule of the next step decides. */
export type Decision = { next: string; advance?: string; dispatch?: NextStep["dispatch"] };

export type NextStep = {
	phase: string | undefined;
	required: string[];
	optional: string[];
	redirects: string[];
	checks: CheckResult[];
	blockingQuestions: Question[];
	counters: { name: string; value: number; cap?: number }[];
	activeUnits: string[];
	/** Pending units waiting on unmet `Depends`. */
	waitingUnits: { id: string; waitingOn: string[] }[];
	startedUnits: string[];
	blockedUnits: { id: string; reason: "attempts" | "progress" }[];
	/** Pending units with a receipt newer than their start whose tick is still missing. */
	untickedReceipts: string[];
	/** Started units whose `unit-start` marks the verifier as pending. */
	pendingVerifier: string[];
	incomplete: string[];
	/** Pending and applying approver requests, in comment order; `mode` is the effective mode. */
	pending: { id: string; subject: string; mode: string; adapter: AdapterName }[];
	/** Frozen and stale units in the lock scope (design D8); empty outside it. */
	frozenUnits: string[];
	staleUnits: string[];
	/** The unanswered stuck report, if any. */
	stuckOpen?: string;
	/** The subagent run the parent should dispatch next; `inline` when it runs in this session. */
	dispatch?: { role: Role; unit?: string; subject?: ReviewSubject; inline: boolean };
	/** A child waiting on an answer. */
	pendingChild?: { agentId: string; question: string };
	advance?: string;
	next: string;
};
