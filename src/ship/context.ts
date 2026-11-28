// The git facts of the ship phase (design D9): one fetch of the integration branch and one change diff per HEAD,
// memoized on the session, plus the durable-docs, reviewed, head-bound gate and re-confirmation facts recomputed
// on every call. `shipStateFor` turns them into `ChangeState.ship` at refresh.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { latestConclusions } from "../docs/behavior-change.ts";
import type { MarkedComment } from "../forge/markers.ts";
import { messageOf } from "../core/messages.ts";
import { parseSpec } from "../core/spec.ts";
import { type Git, integrationBranch } from "../engine/git.ts";
import { validApproval } from "../engine/locks.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { Session } from "../hooks/session.ts";
import { type ChangeDiff, changeDiff } from "./diff.ts";
import { SHIP_PHASE, REVIEW_PHASE } from "./phase.ts";
import { type DurableFacts, durableDocsRule, durableFacts } from "./durable-docs.ts";
import { latestShipRecord } from "./records.ts";
import { isReviewed, type ReviewedResult, reviewedHead } from "./reviewed.ts";

export type ShipContext = {
	diff: ChangeDiff;
	integrationTip: string;
	facts: DurableFacts;
	reviewed: ReviewedResult;
	gatesAtHead: { review: boolean; ship: boolean };
	needsShipGate: boolean;
};

/** What the ship context reads from the change state. */
export type ShipInput = Pick<ChangeState, "git" | "change"> & Partial<Pick<ChangeState, "lock" | "pr" | "marked">>;

type Fetched = { diff: ChangeDiff; integrationTip: string };

type GatesAtHead = ShipContext["gatesAtHead"];

const memo = new WeakMap<Session, { key: string; value: Fetched }>();
const SPECS_DIR = "specs";
const SPECS_PATH = "specs/";

async function fetchOnce(session: Session, state: Pick<ChangeState, "git" | "change">): Promise<Fetched | { refused: string }> {
	const project = session.config.project;
	if (project === null) return { refused: "livespec is not set up in this project." };
	const integration = await integrationBranch(project, session.git);
	if (integration === undefined) return { refused: "no integration branch: set integrationBranch in the livespec config or set origin/HEAD." };
	const key = `${state.git.head}\0${state.change.header.base ?? ""}\0${integration}`;
	const cached = memo.get(session);
	if (cached?.key === key) return cached.value;
	const diff = await changeDiff(session.git, state.change.header.base, integration);
	if ("refused" in diff) return diff;
	let integrationTip: string;
	try {
		integrationTip = await session.git.revParse(`origin/${integration}`);
	} catch (error) {
		return { refused: `cannot read origin/${integration}: ${messageOf(error)}` };
	}
	const value = { diff, integrationTip };
	memo.set(session, { key, value });
	return value;
}

/** Each living spec's capability and `paths`; an unreadable or unparseable spec is left out. */
export async function livingSpecs(root: string): Promise<DurableFacts["specs"]> {
	const entries = await readdir(join(root, SPECS_DIR), { withFileTypes: true }).catch(() => []);
	const specs: DurableFacts["specs"] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === "decisions") continue;
		try {
			const spec = parseSpec(await readFile(join(root, SPECS_DIR, entry.name, "spec.md"), "utf8"), entry.name);
			specs.push({ capability: entry.name, paths: spec.paths });
		} catch {
			// no spec.md or not parseable: the spec-format check reports it
		}
	}
	return specs;
}

const NO_LOCK: ChangeState["lock"] = { locked: undefined, frozen: [], staleUnits: [], gates: {} };

/** `isReviewed`, failing closed: a SHA git cannot walk (e.g. not in this history) is not reviewed. */
async function reviewedSafe(git: Git, reviewed: string | undefined, head: string, tip: string): Promise<ReviewedResult> {
	try {
		return await isReviewed(git, reviewed, head, tip);
	} catch (error) {
		return { ok: false, reason: `cannot check the reviewed SHA: ${messageOf(error)}` };
	}
}

/** Whether a head-bound gate has a valid approval; without one `gatesAtHead` needs no git. */
const anyApproval = (state: ShipInput): boolean => (["review", "ship"] as const).some((p) => validApproval(state.lock?.gates[p]));

/**
 * Per head-bound gate: false when it has an approval whose `head_sha` HEAD is not reviewed against; true without
 * one. Without the integration tip only equality counts.
 */
async function gatesAtHead(git: Git, state: ShipInput, tip: string | undefined): Promise<GatesAtHead> {
	const at = async (phase: keyof GatesAtHead): Promise<boolean> => {
		const gate = state.lock?.gates[phase];
		if (!validApproval(gate)) return true;
		if (tip === undefined) return gate?.headSha === state.git.head;
		return (await reviewedSafe(git, gate?.headSha, state.git.head, tip)).ok;
	};
	return { review: await at("review"), ship: await at("ship") };
}

/** `gatesAtHead` outside a ship context (in `review`, or when it was refused); the fetch is the memoized one. */
async function headBoundGates(session: Session, state: ShipInput): Promise<GatesAtHead> {
	if (!anyApproval(state)) return { review: true, ship: true };
	const fetched = await fetchOnce(session, state).catch(() => undefined);
	const tip = fetched === undefined || "refused" in fetched ? undefined : fetched.integrationTip;
	return gatesAtHead(session.git, state, tip);
}

/**
 * Whether `change_push` would need a ship gate at HEAD (ship-phase "Push tool"): the commits from the pushed
 * head to HEAD change `specs/`, or `durable-docs` has a confirmation item the latest `ship` record does not list.
 */
async function needsShipGate(git: Git, state: ShipInput, facts: DurableFacts): Promise<boolean> {
	const pushed = state.pr?.pushedHead;
	if (pushed !== undefined && pushed !== state.git.head) {
		// A diff git cannot compute fails closed: the ship gate is asked for.
		const specs = await git.diffNames(pushed, state.git.head, SPECS_PATH).catch(() => undefined);
		if (specs === undefined || specs.length > 0) return true;
	}
	const confirmed = new Set(latestShipRecord(state.marked ?? [])?.confirmed ?? []);
	return durableDocsRule(facts).confirm.some((item) => !confirmed.has(item));
}

/** The latest `behavior-change` conclusion per capability, from any source, as ship facts. */
function behaviorFacts(marked: MarkedComment[]): DurableFacts["behavior"] {
	return [...latestConclusions(marked)].map(([capability, c]) => ({ capability, files: c.files, outcome: c.outcome }));
}

/**
 * The fetch and the change diff are memoized by HEAD; the reviewed, head-bound and re-confirmation facts are
 * recomputed on every call, since gate SHAs, the pushed head and `ship` records change without HEAD moving.
 */
export async function shipContext(session: Session, state: ShipInput): Promise<ShipContext | { refused: string }> {
	const fetched = await fetchOnce(session, state);
	if ("refused" in fetched) return fetched;
	const facts = durableFacts(fetched.diff, state.change, await livingSpecs(session.cwd), behaviorFacts(state.marked ?? []));
	const git = session.git;
	const reviewed = await reviewedSafe(git, reviewedHead({ lock: state.lock ?? NO_LOCK }), state.git.head, fetched.integrationTip);
	return {
		...fetched,
		facts,
		reviewed,
		gatesAtHead: await gatesAtHead(git, state, fetched.integrationTip),
		needsShipGate: await needsShipGate(git, state, facts),
	};
}

/** The ship context in the `ship` phase only (undefined elsewhere); a refusal or a git failure is carried, so the check fails closed. */
export async function shipFor(session: Session, state: ShipInput & Pick<ChangeState, "phase">): Promise<ShipContext | { refused: string } | undefined> {
	if (state.phase.kind !== "ok" || state.phase.id !== SHIP_PHASE) return undefined;
	try {
		return await shipContext(session, state);
	} catch (error) {
		return { refused: messageOf(error) };
	}
}

/**
 * `ChangeState.ship` for the phase: in `ship` the durable-docs, reviewed and re-confirmation facts of `ship`, and in
 * `review` and `ship` the head-bound gates; undefined in other phases. A refused context leaves the ship facts out
 * (the `durable-docs` check fails closed) and the head-bound gates fall back to equality.
 */
export async function shipStateFor(
	session: Session,
	state: ShipInput & Pick<ChangeState, "phase">,
	ship: ShipContext | { refused: string } | undefined,
): Promise<ChangeState["ship"]> {
	if (state.phase.kind !== "ok") return undefined;
	if (state.phase.id === REVIEW_PHASE) return { gatesAtHead: await headBoundGates(session, state) };
	if (ship === undefined) return undefined;
	if ("refused" in ship) return { gatesAtHead: await headBoundGates(session, state) };
	return {
		docsRowsNeeded: durableDocsRule(ship.facts).needsRows,
		durableFacts: ship.facts,
		reviewed: ship.reviewed.ok,
		needsShipGate: ship.needsShipGate,
		gatesAtHead: ship.gatesAtHead,
	};
}
