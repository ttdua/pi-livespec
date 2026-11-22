// The forge reads behind `new_dependency` and its validator: the open changes, the current change's
// initiative, and every change option A names followed through their `Depends`, so a cycle through a
// change the drafts do not name is still seen. Throws TooManyDependencies past the read bound.

import type { Change } from "../core/change.ts";
import { parseInitiative } from "../core/initiative.ts";
import { LABEL_LIVESPEC } from "../forge/labels.ts";
import type { Forge, Issue } from "../forge/types.ts";
import { findTracking } from "../initiatives/complete.ts";
import { existingDepends } from "../initiatives/drafts.ts";
import { readReferenced } from "../initiatives/propose-read.ts";
import { initiativeNumber } from "../initiatives/readiness.ts";
import { depsInitiativeName, type NewDependencyCtx } from "./new-dependency.ts";

/** What the reads found, plus the current change's initiative number when it has one. */
export type DependencyRead = NewDependencyCtx & { initiative?: number };

/** Reads the plan context of option A for change issue `current` (its body already parsed as `change`) and the issues `numbers` it names. */
export async function readDependencyCtx(forge: Forge, current: { number: number; title: string }, change: Change, numbers: number[]): Promise<DependencyRead> {
	const t = initiativeNumber(change);
	const [open, tracking, depsTaken] = await Promise.all([
		forge.searchIssues({ labels: [LABEL_LIVESPEC], state: "open" }),
		t === undefined ? undefined : forge.getIssue(t),
		t === undefined ? findTracking(forge, depsInitiativeName(current.title)) : undefined,
	]);
	const initiative = tracking === undefined ? undefined : parseInitiative(tracking.body);
	const entries = initiative?.changes.map((c) => c.number) ?? [];
	const referenced = await readReferenced(forge, [current.number, ...numbers, ...entries]);
	const issues = [...referenced.values()].filter((i): i is Issue => i !== "missing" && i.labels.includes(LABEL_LIVESPEC));
	return { open, referenced, graph: existingDepends(issues, initiative), ...(t === undefined ? {} : { initiative: t }), ...(depsTaken === undefined ? {} : { depsTaken }) };
}
