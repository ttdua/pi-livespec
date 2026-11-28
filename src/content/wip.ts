// Whether work is in progress, which blocks every agent-skills upgrade. A later
// spec registers a finer predicate; the last registered one wins.

import { parseChange } from "../core/change.ts";
import { LABEL_LIVESPEC, phaseLabel } from "../forge/labels.ts";
import type { Forge } from "../forge/types.ts";
import type { Ledger } from "../ledger/index.ts";

export type WorkInProgress = { busy: boolean; change?: number; reason?: string };
export type WorkInProgressFn = (forge: Forge, ledger: Ledger) => Promise<WorkInProgress>;

const BUILD_PHASE = "build";

/** Busy when an open `livespec` change in phase `build` has a pending unit (one search call). */
export const buildPhaseWorkInProgress: WorkInProgressFn = async (forge) => {
	const issues = await forge.searchIssues({ labels: [LABEL_LIVESPEC, phaseLabel(BUILD_PHASE)], state: "open" });
	for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
		const pending = parseChange(issue.body).units.filter((u) => !u.done).map((u) => u.id);
		if (pending.length > 0) {
			return { busy: true, change: issue.number, reason: `change #${issue.number} is in build with pending ${pending.join(", ")}` };
		}
	}
	return { busy: false };
};

let predicate: WorkInProgressFn = buildPhaseWorkInProgress;

export function registerWorkInProgress(fn: WorkInProgressFn): void {
	predicate = fn;
}

export function workInProgress(forge: Forge, ledger: Ledger): Promise<WorkInProgress> {
	return predicate(forge, ledger);
}

export function resetWorkInProgressForTests(): void {
	predicate = buildPhaseWorkInProgress;
}
