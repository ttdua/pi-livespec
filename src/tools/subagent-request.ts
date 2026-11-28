// The run side of the subagent tools: packet context, difficulty, isolation list, dispatch request, record deps and the override warning.

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanReviewerBehavior, recordReviewerConclusions } from "../docs/behavior-review.ts";
import { createGit } from "../engine/git.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import type { Session } from "../hooks/session.ts";
import type { AgentInfo, DispatchDeps, DispatchRequest } from "../subagents/dispatch.ts";
import type { EventsLike } from "../subagents/launch.ts";
import { configuredPackages, excludedPackages } from "../subagents/isolation.ts";
import { changeName } from "../subagents/packet.ts";
import { entriesFor } from "../subagents/policy.ts";
import { aggregateFinding, type Thinking } from "../subagents/records.ts";
import type { Finding, SubagentEntry } from "../subagents/roles.ts";
import { needsContextCount, nextAttempt, nextRound, nextVerifyRound, type RecordDeps } from "../subagents/run-record.ts";
import type { Packet, PacketContext } from "../subagents/source-types.ts";
import { unitRoot } from "../subagents/state.ts";
import type { AppendInput } from "../ledger/entry.ts";
import { lastForgeRef } from "../ledger/merge.ts";
import { afterLedgerWrite, requireChange, type WriteContext } from "./guard.ts";
import type { Target } from "./subagent-target.ts";

/** Where the subagent tools read pi's settings from; tests point `home` at a scratch directory. */
export type SubagentToolDeps = { home: () => string };

export const defaultSubagentDeps: SubagentToolDeps = { home: homedir };

const LEVELS: readonly Thinking[] = ["low", "medium", "high"];
const DEFAULT_DIFFICULTY: Thinking = "medium";

/** The packet context of the session's current change; a unit in an open lane builds in its lane. */
export function packetContext(w: WriteContext, state: ChangeState, unit: string | undefined, finding?: Finding): PacketContext {
	const cwd = unit === undefined ? w.session.cwd : unitRoot(state, unit, w.session.cwd);
	return {
		session: { ...(w.session.activeTree === undefined ? {} : { activeTree: w.session.activeTree }) },
		state, pack: w.pack, forge: w.forge, git: cwd === w.session.cwd ? w.session.git : createGit(cwd), root: w.session.cwd, cwd,
		budgetTokens: w.session.config.user.packetBudgetTokens, ...(finding === undefined ? {} : { finding }),
	};
}

/** The aggregate finding a verifier target names, `undefined` for other roles, or why no aggregate holds it. */
export function findingOf(state: ChangeState, t: Target): Finding | undefined | string {
	if (t.finding === undefined) return undefined;
	const found = aggregateFinding(state.marked, t.finding);
	return found === undefined ? `finding ${t.finding} names no aggregate finding.` : found.finding;
}

const isLevel = (v: string | undefined): v is Thinking => LEVELS.includes(v as Thinking);

/** The unit's `Difficulty`; for a change-level run the highest unit `Difficulty`, or `medium` before units exist. */
export function difficultyOf(state: ChangeState, unit: string | undefined): Thinking {
	const levels = state.change.units.filter((u) => unit === undefined || u.id === unit).map((u) => u.difficulty).filter(isLevel);
	if (levels.length === 0) return DEFAULT_DIFFICULTY;
	return LEVELS[Math.max(...levels.map((l) => LEVELS.indexOf(l)))] as Thinking;
}

function entryOf(w: WriteContext, state: ChangeState, t: Target): SubagentEntry | undefined {
	const phase = state.phase.kind === "ok" ? state.phase.id : undefined;
	return phase === undefined ? undefined : entriesFor(w.pack, phase).find((e) => e.role === t.role && e.subject === t.subject);
}

/** The effective isolation list: configured packages of known flows plus the user's `isolation.excludePackages`. */
export async function exclusionsOf(session: Session, deps: SubagentToolDeps): Promise<string[]> {
	return excludedPackages(await configuredPackages(session.cwd, deps.home()), session.config.user.isolation.excludePackages);
}

/** Everything `runDispatch` needs to know about the run, with counters read from the forge records. */
export async function dispatchRequest(w: WriteContext, state: ChangeState, t: Target, packet: Packet, deps: SubagentToolDeps): Promise<DispatchRequest> {
	const entry = entryOf(w, state, t);
	const lane = t.unit !== undefined && state.subagents.lanes[t.unit] !== undefined ? t.unit : undefined;
	return {
		...t, packet, change: changeName(packetContext(w, state, t.unit)),
		...(entry === undefined ? {} : { entry }), ...(lane === undefined ? {} : { lane }),
		difficulty: difficultyOf(state, t.unit), failedAttempts: t.unit === undefined ? 0 : (state.evidence.attempts[t.unit] ?? 0),
		exclusions: await exclusionsOf(w.session, deps),
		attempt: nextAttempt(state.marked, t.role, t.unit), round: t.finding === undefined ? nextRound(state.marked, t.role, t.unit, t.subject) : nextVerifyRound(state.marked, t.finding),
		...(t.finding === undefined ? {} : { finding: t.finding }), needsContext: needsContextCount(state.marked, t.unit, t.role),
	};
}

/** Appends `input` to the change's ledger after the last own forge record of the session's current card, then refreshes the card. */
export async function appendRecord(w: WriteContext, issue: number, input: AppendInput): Promise<void> {
	const change = requireChange(w.session);
	const after = change.ok ? lastForgeRef(change.state.marked) : undefined;
	await w.ledger.append(issue, { ...input, ...(after === undefined ? {} : { after }) });
	await afterLedgerWrite(w.session, issue);
}

/** Appends to the ledger and keeps the card fresh; git reads run in the run's cwd. */
export function recordDeps(w: WriteContext, issue: number): RecordDeps {
	return {
		record: (input) => appendRecord(w, issue, input),
		headOf: (cwd) => createGit(cwd).head(),
		reachable: async (cwd, commits) => {
			const git = createGit(cwd);
			const head = await git.head();
			const kept: string[] = [];
			for (const c of commits) if (await git.isAncestor(c, head).catch(() => false)) kept.push(c);
			return kept;
		},
	};
}

const warned = new WeakMap<Session, Set<string>>();

/** Warns once per session about a role agent that a user or package file overrides. */
export function overrideWarner(session: Session, notify: (text: string) => void): (agent: AgentInfo) => void {
	return (agent) => {
		const seen = warned.get(session) ?? new Set<string>();
		warned.set(session, seen);
		if (seen.has(agent.name)) return;
		seen.add(agent.name);
		notify(`livespec: the ${agent.name} agent comes from ${agent.source}${agent.filePath ? ` (${agent.filePath})` : ""}, not the executor's built-in; it is used as is.`);
	};
}

/** The dispatch side effects of the tools: the executor, pi's event bus, the forge and git. */
export function dispatchDeps(pi: ExtensionAPI, w: WriteContext, issue: number, service: DispatchDeps["service"], notify: (text: string) => void): DispatchDeps {
	const record = recordDeps(w, issue);
	return { ...record, prepareResult: cleanReviewerBehavior, afterRecord: (run, result) => recordReviewerConclusions(record.record, run, result, run.packet), service, events: (pi as unknown as { events: EventsLike }).events, onOverride: overrideWarner(w.session, notify) };
}

/** The packet as text for the parent, untrusted parts already wrapped by the builder. */
export function packetText(packet: Packet): string {
	const skills = packet.skillPaths.length === 0 ? "none" : packet.skillPaths.join(", ");
	return `Packet ${packet.hash} (cwd ${packet.cwd}; skills: ${untrusted(skills)})\n\n${packet.text}`;
}
