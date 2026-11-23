// The readiness refresh facts (design D3): dependency states, initiative progress, capability overlap and the
// `split` outcome in `shape`, registered on the card input so the engine never imports this module.
//
// Issue reads run on every refresh; only the pull request reads are memoized on the session, keyed by the
// sorted versions of the issues read, since a merge is only seen once a dependency issue changes.

import { parseChange } from "../core/change.ts";
import { type Initiative, parseInitiative } from "../core/initiative.ts";
import { decide } from "../decide/seam.ts";
import { parkedState } from "../deps/parked.ts";
import type { DepFact, DepState } from "../engine/deps-facts.ts";
import { GitError, integrationBranch } from "../engine/git.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { OpenChange } from "../engine/resolve-change.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { ForgeError } from "../forge/errors.ts";
import { LABEL_LIVESPEC, LABEL_PARKED } from "../forge/labels.ts";
import type { CachedForge } from "../forge/cache.ts";
import type { Issue } from "../forge/types.ts";
import { registerListFacts, registerRefreshFacts } from "../hooks/card-input.ts";
import type { Session } from "../hooks/session.ts";
import { type DependencyTarget, DependencyReadError, dependencyFact, dependencyNumbers, initiativeNumber, type IssueRead, type MergedRead, readDependencyIssues } from "./readiness.ts";
import { splitFacts } from "./split-rule.ts";

type Deps = NonNullable<ChangeState["deps"]>;
type RefreshResult = Partial<Pick<ChangeState, "deps" | "parked">>;

const SHAPE_PHASE = "shape";

const capabilitiesOf = (body: string): string[] => {
	const caps = parseChange(body).header.capabilities;
	return caps === undefined ? [] : [...caps.new, ...caps.modified];
};

/** Every other open change with a `Branch` line that declares a capability this change declares. */
export function capabilityOverlap(target: DependencyTarget, open: Issue[]): Deps["overlap"] {
	const caps = target.change.header.capabilities;
	const own = new Set(caps === undefined ? [] : [...caps.new, ...caps.modified]);
	return open
		.filter((i) => i.number !== target.issue.number && parseChange(i.body).header.branch !== undefined)
		.map((i) => ({ number: i.number, title: i.title, capabilities: [...new Set(capabilitiesOf(i.body).filter((c) => own.has(c)))] }))
		.filter((o) => o.capabilities.length > 0);
}

/** Entries that are open, not started (no `Branch`) and not `current`: the ones a human may start next. */
function unstartedEntries(initiative: Initiative, current: number, open: Map<number, Issue>): { number: number; name: string; depends: number[] }[] {
	return initiative.changes.flatMap((e) => {
		const issue = open.get(e.number);
		if (e.checked || e.number === current || issue === undefined) return [];
		const change = parseChange(issue.body);
		if (change.header.branch !== undefined) return [];
		return [{ number: e.number, name: e.name, depends: dependencyNumbers({ issue: { number: e.number }, change }, initiative) }];
	});
}

/** Checked over all entries, and the unstarted entries whose dependencies `known` reports all merged. */
export function initiativeProgress(number: number, initiative: Initiative, current: number, known: Map<number, DepState>, open: Issue[]): NonNullable<Deps["initiative"]> {
	const ready = unstartedEntries(initiative, current, new Map(open.map((i) => [i.number, i])))
		.filter((e) => e.depends.every((d) => known.get(d) === "merged"))
		.map(({ number: n, name }) => ({ number: n, name }));
	return { number, checked: initiative.changes.filter((e) => e.checked).length, total: initiative.changes.length, ready };
}

/** A pull request read memoized on the session; the memo is dropped when any issue read in this pass changed. */
function memoMerged(session: Session, forge: CachedForge, issues: Issue[]): MergedRead {
	const key = [...new Set(issues.map((i) => `${i.number}:${i.version}`))].sort().join("\0");
	if (session.depsMemo?.key !== key) session.depsMemo = { key, merged: new Map() };
	const merged = session.depsMemo.merged;
	return async (pr) => {
		const known = merged.get(pr);
		if (known !== undefined) return known;
		const value = (await forge.getPullRequest(pr)).merged;
		merged.set(pr, value);
		return value;
	};
}

/** Reads issues once per pass: an open change comes from the search, any other issue from the forge. */
function passReader(forge: CachedForge, open: Issue[]): IssueRead {
	const seen = new Map<number, Promise<Issue>>(open.map((i) => [i.number, Promise.resolve(i)]));
	return (n) => {
		const cached = seen.get(n);
		if (cached) return cached;
		const read = forge.getIssue(n);
		seen.set(n, read);
		return read;
	};
}

/** The states of `numbers`, read through `read`; an open issue costs no pull request read. */
async function statesOf(read: IssueRead, numbers: number[], merged: MergedRead): Promise<Map<number, DepState>> {
	const facts = await Promise.all([...new Set(numbers)].map(async (n) => dependencyFact(await read(n), merged)));
	return new Map(facts.map((f) => [f.number, f.state]));
}

async function splitOutcome(pack: Pack, state: ChangeState): Promise<Deps["split"]> {
	if (state.phase.kind !== "ok" || state.phase.id !== SHAPE_PHASE) return undefined;
	const decided = await decide("split", splitFacts(state.change, pack.limits), { config: pack.decisions.split, subject: `#${state.issue.number}` });
	return decided.status === "decided" && (decided.outcome === "propose" || decided.outcome === "single") ? decided.outcome : undefined;
}

const REMOTE = "origin";

/**
 * Whether the local `origin/<integration>` is not an ancestor of HEAD, read without fetching; undefined when
 * the change is not started, the integration branch is unknown or git cannot answer.
 */
async function integrationAhead(session: Session, state: ChangeState): Promise<boolean | undefined> {
	const project = session.config.project;
	if (state.change.header.branch === undefined || project === null) return undefined;
	try {
		const integration = await integrationBranch(project, session.git);
		const tip = integration === undefined ? undefined : await session.git.remoteRef(`${REMOTE}/${integration}`);
		return tip === undefined ? undefined : !(await session.git.isAncestor(tip, "HEAD"));
	} catch (error) {
		if (error instanceof GitError) return undefined;
		throw error;
	}
}

/** The sync facts of a change with an initiative: computed on every refresh, never memoized. */
async function syncFacts(session: Session, state: ChangeState, initiative: Initiative): Promise<Pick<Deps, "integrationAhead" | "siblingMerged">> {
	const siblingMerged = initiative.changes.some((e) => e.checked && e.number !== state.issue.number);
	const ahead = await integrationAhead(session, state);
	return { siblingMerged, ...(ahead === undefined ? {} : { integrationAhead: ahead }) };
}

async function changeFacts(session: Session, forge: CachedForge, pack: Pack, state: ChangeState): Promise<Deps> {
	const open = await forge.searchIssues({ labels: [LABEL_LIVESPEC], state: "open" });
	const openMap = new Map(open.map((i) => [i.number, i]));
	const read = passReader(forge, open);
	const { initiative, issues } = await readDependencyIssues(read, state, { allowStale: true });
	const entryDeps = initiative ? unstartedEntries(initiative.parsed, state.issue.number, openMap).flatMap((e) => e.depends) : [];
	const entryIssues = await Promise.all([...new Set(entryDeps)].map(read));
	const merged = memoMerged(session, forge, [...(initiative ? [initiative.issue] : []), ...issues, ...entryIssues]);
	const items: DepFact[] = await Promise.all(issues.map((i) => dependencyFact(i, merged)));
	const known = new Map([...(await statesOf(read, entryDeps, merged)), ...items.map((f) => [f.number, f.state] as const)]);
	const t = initiativeNumber(state.change);
	const split = await splitOutcome(pack, state);
	return {
		items,
		...(initiative && t !== undefined ? { initiative: initiativeProgress(t, initiative.parsed, state.issue.number, known, open) } : {}),
		overlap: capabilityOverlap(state, open),
		...(initiative ? await syncFacts(session, state, initiative.parsed) : {}),
		...(split === undefined ? {} : { split }),
	};
}

const isReadFailure = (error: unknown): boolean => error instanceof ForgeError || error instanceof DependencyReadError;

/** The `deps` refresh fact; a forge failure is recorded and leaves the fact out, so the card still builds. */
export async function depsRefreshFacts(session: Session, state: ChangeState): Promise<RefreshResult> {
	const forge = session.forge;
	if (forge === undefined || !session.pack.ok) return {};
	try {
		const deps = await changeFacts(session, forge, session.pack.pack, state);
		const parked = parkedState(state.parkedCore, deps.items);
		return { deps, ...(parked === undefined ? {} : { parked }) };
	} catch (error) {
		if (!isReadFailure(error)) throw error;
		session.record("deps", error);
		return {};
	}
}

type Listed = { issue: Issue; numbers: number[]; deps: Issue[] };

/** The issue of a listed change, its dependency numbers and their issues; a parked change reads nothing more. */
async function listedIssues(read: IssueRead, n: number): Promise<Listed> {
	const issue = await read(n);
	if (issue.labels.includes(LABEL_PARKED)) return { issue, numbers: [], deps: [] };
	const change = parseChange(issue.body);
	const t = initiativeNumber(change);
	const initiative = t === undefined ? undefined : await read(t);
	const numbers = dependencyNumbers({ issue: { number: n }, change }, initiative && parseInitiative(initiative.body));
	return { issue, numbers, deps: [...(initiative ? [initiative] : []), ...(await Promise.all(numbers.map(read)))] };
}

/** `parked` (from the `livespec:parked` label), `ready`, or the dependencies that are not merged. */
async function readinessOf(l: Listed, read: IssueRead, merged: MergedRead): Promise<OpenChange["readiness"]> {
	if (l.issue.labels.includes(LABEL_PARKED)) return "parked";
	const states = await statesOf(read, l.numbers, merged);
	const waits = l.numbers.filter((n) => states.get(n) !== "merged");
	return waits.length === 0 ? "ready" : { waits };
}

/** Adds `readiness` to each listed change; a forge failure is recorded and leaves the list as it was. */
export async function listReadiness(session: Session, listed: OpenChange[]): Promise<OpenChange[]> {
	const forge = session.forge;
	if (forge === undefined || listed.length === 0) return listed;
	try {
		const read = passReader(forge, await forge.searchIssues({ labels: [LABEL_LIVESPEC], state: "open" }));
		const all = await Promise.all(listed.map((c) => listedIssues(read, c.number)));
		const merged = memoMerged(session, forge, all.flatMap((l) => [l.issue, ...l.deps]));
		return await Promise.all(listed.map(async (c, i) => ({ ...c, readiness: await readinessOf(all[i] as Listed, read, merged) })));
	} catch (error) {
		if (!isReadFailure(error)) throw error;
		session.record("deps", error);
		return listed;
	}
}

registerRefreshFacts(depsRefreshFacts);
registerListFacts(listReadiness);
