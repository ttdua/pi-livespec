// Work in progress from started units: busy only while an open `build` change has a unit whose
// `unit-start` is newer than its latest receipt. A pending unit between starts does not block.

import { parseChange } from "../core/change.ts";
import { type WorkInProgress, type WorkInProgressFn, registerWorkInProgress } from "../content/wip.ts";
import { LABEL_LIVESPEC, phaseLabel } from "../forge/labels.ts";
import type { Forge, Issue } from "../forge/types.ts";
import type { Ledger } from "../ledger/index.ts";
import { readOwnRecords } from "../ledger/records.ts";
import { deriveUnitEvidence } from "./unit-state.ts";

const BUILD_PHASE = "build";
const IDLE: WorkInProgress = { busy: false };

/** The first started unit of `issue`, read from its own records; undefined when none is started. */
async function startedUnitOf(forge: Forge, ledger: Ledger, login: string, issue: Issue): Promise<WorkInProgress | undefined> {
	// A ledger that cannot be verified is not idle: another clone may be building (agent-skills-content fail-safe).
	if ((await ledger.ensureFetched(issue.number)) !== "fetched") throw new Error(`the ledger of #${issue.number} could not be fetched, so work in progress is unknown`);
	const { records } = await readOwnRecords(forge, ledger, issue.number, { login });
	const evidence = deriveUnitEvidence(parseChange(issue.body), records, undefined);
	const unit = Object.keys(evidence.started)[0];
	if (unit === undefined) return undefined;
	return { busy: true, change: issue.number, reason: `change #${issue.number} has ${unit} started` };
}

export const startedUnitWorkInProgress: WorkInProgressFn = async (forge, ledger) => {
	const issues = await forge.searchIssues({ labels: [LABEL_LIVESPEC, phaseLabel(BUILD_PHASE)], state: "open" });
	if (issues.length === 0) return IDLE;
	// `whoami` throws while the forge is unreachable, so work in progress is unknown rather than idle.
	const { login } = await forge.whoami();
	for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
		const busy = await startedUnitOf(forge, ledger, login, issue);
		if (busy) return busy;
	}
	return IDLE;
};

export function registerStartedUnitWorkInProgress(): void {
	registerWorkInProgress(startedUnitWorkInProgress);
}
