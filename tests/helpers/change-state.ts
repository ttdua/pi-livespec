import { readFileSync } from "node:fs";
import { parseChange } from "../../src/core/change.ts";
import type { ChangeState } from "../../src/engine/state-types.ts";

/** The LS-02 fixture body: Base and Branch set, Q1 open and blocking, U1 done, U3 pending (Depends U1). */
export const FIXTURE_BODY = readFileSync(new URL("../fixtures/change-body.md", import.meta.url), "utf8");

/** A hand-built ChangeState with everything present and passing; override what a test needs. */
export function stateFor(phase: string, overrides: Partial<ChangeState> = {}, body = FIXTURE_BODY): ChangeState {
	return {
		issue: { number: 7, title: "per-ip-cap", labels: ["livespec", `livespec:phase/${phase}`], state: "open" },
		phase: { kind: "ok", id: phase },
		change: parseChange(body),
		sections: { Capabilities: true, Proposal: true, Design: true, Units: true },
		counters: {},
		skillNotes: [],
		incomplete: [],
		git: { branch: "livespec/per-ip-cap", head: "f".repeat(40), dirty: false, specsChanged: true },
		checks: [],
		stale: false,
		readOnly: false,
		warnings: [],
		marked: [],
		requests: { pending: [], applying: [] },
		lock: { locked: undefined, frozen: [], staleUnits: [], gates: {} },
		iterations: { count: 0, cap: undefined, blocking: false, stuckOpen: undefined },
		commandWarnings: [],
		evidence: { started: {}, receipts: {}, attempts: {}, blocked: {}, untickedReceipts: [] },
		subagents: { executor: { ok: false, missing: [] }, turnsCompleted: 0, lanes: {}, unfamiliar: { change: false, units: {} } },
		...overrides,
	};
}
