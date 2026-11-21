export type PhaseOutput =
	| "issue#Capabilities"
	| "issue#Proposal"
	| "issue#Design"
	| "issue#Units"
	| "issue#Durable docs"
	| "specs-diff";

export type Phase = {
	id: string;
	requires: string[];
	per?: "unit";
	skills: { required: string[]; optional: string[] };
	outputs: PhaseOutput[];
	redirects: string[];
	checks: string[];
	gate: "none" | "self" | "human";
	subagents: unknown[];
};

export type Pack = {
	name: string;
	version: 1;
	content: string;
	limits: Record<string, number>;
	loops: Record<string, number>;
	decisions: Record<string, unknown>;
	init: { skills: string[] };
	phases: Phase[];
};

/** `line` and `col` are 1-based. */
export type PackError = {
	severity: "error" | "warning";
	file: string;
	line: number;
	col: number;
	path: string;
	message: string;
};

export type LoadedPack =
	| { ok: true; pack: Pack; warnings: PackError[] }
	| { ok: false; errors: PackError[] };
