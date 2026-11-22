// The forge reads behind `initiative_propose` and its validator: every issue a plan names, followed
// through the `Depends` lines of the livespec changes it reaches, so a cycle through a change the input
// does not name is still seen.

import { parseChange } from "../core/change.ts";
import { ForgeError } from "../forge/errors.ts";
import { LABEL_LIVESPEC } from "../forge/labels.ts";
import type { Forge, Issue } from "../forge/types.ts";

const NOT_FOUND = 404;
/** A bound on the issues followed, so a long chain cannot turn one tool call into unbounded reads. */
export const MAX_READS = 200;

/** More issues than MAX_READS would have to be read: a cycle could hide beyond them, so the caller refuses. */
export class TooManyDependencies extends Error {
	constructor() {
		super(`too many dependencies to check (more than ${MAX_READS} issues)`);
		this.name = "TooManyDependencies";
	}
}

async function readOne(forge: Forge, n: number): Promise<Issue | "missing"> {
	try {
		return await forge.getIssue(n);
	} catch (error) {
		if (error instanceof ForgeError && error.status === NOT_FOUND) return "missing";
		throw error;
	}
}

const ownDepends = (issue: Issue): number[] => (parseChange(issue.body).header.depends ?? []).flatMap((d) => [...d.matchAll(/#(\d+)/g)].map((m) => Number(m[1])));

/** Reads `start` and, from each livespec change read, the changes its `Depends` line names; throws TooManyDependencies past MAX_READS. */
export async function readReferenced(forge: Forge, start: number[]): Promise<Map<number, Issue | "missing">> {
	const out = new Map<number, Issue | "missing">();
	const queue = [...new Set(start)];
	while (queue.length > 0) {
		const n = queue.shift() as number;
		if (out.has(n)) continue;
		if (out.size >= MAX_READS) throw new TooManyDependencies();
		const issue = await readOne(forge, n);
		out.set(n, issue);
		if (issue !== "missing" && issue.labels.includes(LABEL_LIVESPEC)) queue.push(...ownDepends(issue).filter((d) => !out.has(d)));
	}
	return out;
}
