// Reads the state of the changes another change depends on.

import { parseChange } from "../core/change.ts";
import type { DepFact } from "../engine/deps-facts.ts";
import type { Forge } from "../forge/types.ts";
import { parsePrNumber } from "../ship/pull-request.ts";

/** Reads each dependency; a forge error rejects. A closed change without a merged PR is abandoned. */
export async function readDependencies(forge: Forge, numbers: number[]): Promise<DepFact[]> {
	return Promise.all(numbers.map((number) => readOne(forge, number)));
}

async function readOne(forge: Forge, number: number): Promise<DepFact> {
	const issue = await forge.getIssue(number);
	if (issue.state === "open") return { number, title: issue.title, state: "open" };
	const pr = parseChange(issue.body).header.pr;
	const prNumber = pr === undefined ? undefined : parsePrNumber(pr);
	if (prNumber === undefined) return { number, title: issue.title, state: "abandoned" };
	const pull = await forge.getPullRequest(prNumber);
	return { number, title: issue.title, state: pull.merged ? "merged" : "abandoned" };
}

export function isReady(facts: DepFact[]): boolean {
	return facts.every((f) => f.state === "merged");
}
