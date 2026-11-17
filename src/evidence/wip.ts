// Work in progress from started units: busy only while an open `build` change has a unit whose
// `unit-start` is newer than its latest receipt. A pending unit between starts does not block.

import { parseChange } from "../core/change.ts";
import { type WorkInProgress, type WorkInProgressFn, registerWorkInProgress } from "../content/wip.ts";
import { LABEL_LIVESPEC, phaseLabel } from "../forge/labels.ts";
import { readMarkedComments } from "../forge/markers.ts";
import type { Forge, Issue } from "../forge/types.ts";
import { deriveUnitEvidence } from "./unit-state.ts";

const BUILD_PHASE = "build";
const IDLE: WorkInProgress = { busy: false };

/** The first started unit of `issue`, read from its own marked comments; undefined when none is started. */
async function startedUnitOf(forge: Forge, issue: Issue): Promise<WorkInProgress | undefined> {
	const { comments } = await readMarkedComments(forge, issue.number);
	const evidence = deriveUnitEvidence(parseChange(issue.body), comments, undefined);
	const unit = Object.keys(evidence.started)[0];
	if (unit === undefined) return undefined;
	return { busy: true, change: issue.number, reason: `change #${issue.number} has ${unit} started` };
}

export const startedUnitWorkInProgress: WorkInProgressFn = async (forge) => {
	const issues = await forge.searchIssues({ labels: [LABEL_LIVESPEC, phaseLabel(BUILD_PHASE)], state: "open" });
	for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
		const busy = await startedUnitOf(forge, issue);
		if (busy) return busy;
	}
	return IDLE;
};

export function registerStartedUnitWorkInProgress(): void {
	registerWorkInProgress(startedUnitWorkInProgress);
}
