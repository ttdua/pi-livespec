// Reads the state of the changes another change depends on (design D2): the union of the change's own
// `Depends` line and its initiative entry's `Depends`, each read from the forge.

import { type Change, parseChange } from "../core/change.ts";
import { type Initiative, parseInitiative } from "../core/initiative.ts";
import type { DepFact } from "../engine/deps-facts.ts";
import { ForgeError } from "../forge/errors.ts";
import type { Forge, Issue } from "../forge/types.ts";
import { parsePrNumber } from "../ship/pull-request.ts";

/** The change whose dependencies are read: its issue number and parsed body (a `ChangeState` fits). */
export type DependencyTarget = { issue: { number: number }; change: Change };

/** Reads one issue. */
export type IssueRead = (n: number) => Promise<Issue>;
/** Whether pull request `pr` is merged. */
export type MergedRead = (pr: number) => Promise<boolean>;

/** Issue `number` (a dependency or the initiative) failed with a forge error (`cause`), or came only from the read-only cache (`stale`). */
export class DependencyReadError extends Error {
	readonly number: number;
	readonly stale: boolean;

	constructor(number: number, o: { stale?: boolean; cause?: unknown } = {}) {
		super(o.stale ? `#${number} was read from the cache` : `#${number} cannot be read from the forge`, { cause: o.cause });
		this.name = "DependencyReadError";
		this.number = number;
		this.stale = o.stale === true;
	}
}

export type DependencyIssues = { initiative?: { issue: Issue; parsed: Initiative }; issues: Issue[] };

export const mergedOn =
	(forge: Forge): MergedRead =>
	async (pr) =>
		(await forge.getPullRequest(pr)).merged;

/** Reads each dependency; a forge error rejects. A closed change without a merged PR is abandoned. */
export async function readDependencies(forge: Forge, numbers: number[]): Promise<DepFact[]> {
	return Promise.all(numbers.map(async (number) => dependencyFact(await forge.getIssue(number), mergedOn(forge))));
}

/** The state of one dependency from its issue; only a closed issue with a `PR` line reads the pull request. */
export async function dependencyFact(issue: Issue, merged: MergedRead): Promise<DepFact> {
	const { number, title } = issue;
	if (issue.state === "open") return { number, title, state: "open" };
	const pr = parseChange(issue.body).header.pr;
	const prNumber = pr === undefined ? undefined : parsePrNumber(pr);
	if (prNumber === undefined) return { number, title, state: "abandoned" };
	return { number, title, state: (await merged(prNumber)) ? "merged" : "abandoned" };
}

export function isReady(facts: DepFact[]): boolean {
	return facts.every((f) => f.state === "merged");
}

const ISSUE_REF = /^#(\d+)$/;

/** `30` of an `Initiative: #30` line; undefined without one or when it names no issue. */
export function initiativeNumber(change: Change): number | undefined {
	const m = ISSUE_REF.exec(change.header.initiative?.trim() ?? "");
	return m ? Number(m[1]) : undefined;
}

const issueRefs = (refs: string[]): number[] => refs.flatMap((r) => [...r.matchAll(/#(\d+)/g)].map((m) => Number(m[1])));

/** The union of the change's own `Depends` numbers and those of its entry in `initiative`, in first-seen order. */
export function dependencyNumbers(target: DependencyTarget, initiative?: Initiative): number[] {
	const entry = initiative?.changes.find((c) => c.number === target.issue.number);
	const own = issueRefs(target.change.header.depends ?? []);
	return [...new Set([...own, ...(entry?.depends ?? [])])].filter((n) => n !== target.issue.number);
}

/** A forge error names the issue it failed on; any other error is a bug and passes through. */
function asReadError(n: number, cause: unknown): unknown {
	return cause instanceof ForgeError ? new DependencyReadError(n, { cause }) : cause;
}

/** One read; a thrown forge error or a cached (stale) copy becomes a DependencyReadError naming `n`. */
async function readFresh(read: IssueRead, n: number, allowStale: boolean): Promise<Issue> {
	let issue: Issue;
	try {
		issue = await read(n);
	} catch (cause) {
		throw asReadError(n, cause);
	}
	if (issue.stale && !allowStale) throw new DependencyReadError(n, { stale: true });
	return issue;
}

/**
 * Reads the initiative issue (when named) and every dependency issue. A failed read, or a cached one unless
 * `allowStale` (the card, which is marked stale anyway), rejects with DependencyReadError.
 */
export async function readDependencyIssues(read: IssueRead, target: DependencyTarget, o: { allowStale?: boolean } = {}): Promise<DependencyIssues> {
	const allowStale = o.allowStale === true;
	const t = initiativeNumber(target.change);
	const initiativeIssue = t === undefined ? undefined : await readFresh(read, t, allowStale);
	const initiative = initiativeIssue && { issue: initiativeIssue, parsed: parseInitiative(initiativeIssue.body) };
	const issues = await Promise.all(dependencyNumbers(target, initiative?.parsed).map((n) => readFresh(read, n, allowStale)));
	return { ...(initiative ? { initiative } : {}), issues };
}

/** The dependency facts of a change, read fresh; rejects with DependencyReadError on a failed or cached read. */
export async function changeDependencies(forge: Forge, target: DependencyTarget): Promise<DepFact[]> {
	const { issues } = await readDependencyIssues((n) => forge.getIssue(n), target);
	const merged = mergedOn(forge);
	return Promise.all(
		issues.map(async (issue) => {
			try {
				return await dependencyFact(issue, merged);
			} catch (cause) {
				throw asReadError(issue.number, cause);
			}
		}),
	);
}
