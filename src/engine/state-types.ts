// Plain data shapes shared by the snapshot reader, the checks runner and the
// pure next-step decision.

import type { Change, Question } from "../core/change.ts";
import type { Result } from "../core/result.ts";

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
	checks: Result[];
	stale: boolean;
	readOnly: boolean;
	warnings: string[];
};

export type NextStep = {
	phase: string | undefined;
	required: string[];
	optional: string[];
	redirects: string[];
	checks: Result[];
	blockingQuestions: Question[];
	counters: { name: string; value: number; cap?: number }[];
	activeUnits: string[];
	blockedUnits: { id: string; waitingOn: string[] }[];
	incomplete: string[];
	advance?: string;
	next: string;
};
