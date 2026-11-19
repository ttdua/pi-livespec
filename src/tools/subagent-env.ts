// What the subagent tools share: parameter checks, the packet context of the session, the dispatch request and the record side effects.

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGit } from "../engine/git.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import type { Session } from "../hooks/session.ts";
import type { AgentInfo, DispatchDeps, DispatchRequest } from "../subagents/dispatch.ts";
import type { EventsLike } from "../subagents/launch.ts";
import { type ChildCheckContext, isChildSession } from "../subagents/child.ts";
import { configuredPackages, excludedPackages } from "../subagents/isolation.ts";
import { changeName } from "../subagents/packet.ts";
import { entriesFor } from "../subagents/policy.ts";
import type { Thinking } from "../subagents/records.ts";
import { AGENT_OF, ROLE_SUBJECTS, type ReviewSubject, type Role, type SubagentEntry } from "../subagents/roles.ts";
import { needsContextCount, nextAttempt, nextRound, type RecordDeps } from "../subagents/run-record.ts";
import type { Packet, PacketContext } from "../subagents/source-types.ts";
import { unitRoot } from "../subagents/state.ts";
import { afterForgeWrite, type ToolResult, toolResult, type WriteContext } from "./guard.ts";

/** Where the subagent tools read pi's settings from; tests point `home` at a scratch directory. */
export type SubagentToolDeps = { home: () => string };

export const defaultSubagentDeps: SubagentToolDeps = { home: homedir };

export type TargetParams = { role: string; unit?: string; subject?: string };
export type Target = { role: Role; unit?: string; subject?: ReviewSubject };

export const CHILD_REFUSAL = (tool: string): string => `${tool} refused: only the main session dispatches and records subagent runs; this is a child session. Nothing was launched or written.`;

/** What a tool reads from pi's tool context: the session check and the UI notifier. */
export type ToolCtx = ChildCheckContext & { ui?: { notify?(message: string, type?: "info" | "warning" | "error"): void } };

/** Refuses in a child session before anything else runs. */
export const childRefusal = (tool: string, ctx: ToolCtx): ToolResult<undefined> | undefined => (isChildSession(ctx) ? toolResult(CHILD_REFUSAL(tool), undefined, true) : undefined);

export const warn = (ctx: ToolCtx) => (text: string): void => ctx.ui?.notify?.(text, "warning");

const LEVELS: readonly Thinking[] = ["low", "medium", "high"];
const DEFAULT_DIFFICULTY: Thinking = "medium";

export const refusal = (tool: string, message: string): ToolResult<undefined> => toolResult(`${tool} refused: ${message} Nothing was launched or written.`, undefined, true);

const isSubject = (s: string): s is ReviewSubject => (ROLE_SUBJECTS as readonly string[]).includes(s) || (s.startsWith("persona:") && s.length > "persona:".length);

/** The role, subject and unit, or why they cannot name a run; the unit must exist in the change. */
export function checkTarget(p: TargetParams, state: ChangeState): Target | string {
	if (!(p.role in AGENT_OF)) return `unknown role ${JSON.stringify(p.role)}; use one of ${Object.keys(AGENT_OF).join(", ")}.`;
	const role = p.role as Role;
	if (p.subject !== undefined && !isSubject(p.subject)) return `unknown subject ${JSON.stringify(p.subject)}; use one of ${ROLE_SUBJECTS.join(", ")} or persona:<name>.`;
	if (role === "reviewer" && p.subject === undefined) return "a reviewer needs a subject (spec, plan, unit, change or persona:<name>).";
	const needsUnit = role === "implementer" || p.subject === "unit";
	if (needsUnit && (p.unit === undefined || p.unit === "")) return `a unit id is required for ${[role, p.subject].filter(Boolean).join(" ")}.`;
	if (p.unit !== undefined && !state.change.units.some((u) => u.id === p.unit)) return `unit ${p.unit} does not exist in the change.`;
	return { role, ...(p.unit === undefined ? {} : { unit: p.unit }), ...(p.subject === undefined ? {} : { subject: p.subject as ReviewSubject }) };
}

export const argsOf = (t: Target): string => [t.role, t.unit, t.subject].filter((p) => p !== undefined).join(" ");

/** The packet context of the session's current change; a unit in an open lane builds in its lane. */
export function packetContext(w: WriteContext, state: ChangeState, unit: string | undefined): PacketContext {
	const cwd = unit === undefined ? w.session.cwd : unitRoot(state, unit, w.session.cwd);
	return {
		session: { ...(w.session.activeTree === undefined ? {} : { activeTree: w.session.activeTree }) },
		state, pack: w.pack, forge: w.forge, git: cwd === w.session.cwd ? w.session.git : createGit(cwd), root: w.session.cwd, cwd,
		budgetTokens: w.session.config.user.packetBudgetTokens,
	};
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
		attempt: nextAttempt(state.marked, t.role, t.unit), round: nextRound(state.marked, t.role, t.unit, t.subject), needsContext: needsContextCount(state.marked, t.unit),
	};
}

/** Posts on the change issue and keeps the card fresh; git reads run in the run's cwd. */
export function recordDeps(w: WriteContext, issue: number): RecordDeps {
	return {
		post: async (body) => {
			await w.forge.createComment(issue, body);
			await afterForgeWrite(w.session, issue);
		},
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
	return { ...recordDeps(w, issue), service, events: (pi as unknown as { events: EventsLike }).events, onOverride: overrideWarner(w.session, notify) };
}

/** The packet as text for the parent, untrusted parts already wrapped by the builder. */
export function packetText(packet: Packet): string {
	const skills = packet.skillPaths.length === 0 ? "none" : packet.skillPaths.join(", ");
	return `Packet ${packet.hash} (cwd ${packet.cwd}; skills: ${untrusted(skills)})\n\n${packet.text}`;
}

/** Parameters shared by `subagent_dispatch`, `subagent_packet` and `subagent_record`. */
export const TARGET_PROPERTIES = {
	role: { type: "string", enum: Object.keys(AGENT_OF) },
	unit: { type: "string", description: "Unit id such as U3; required for implementer, verifier and the unit subject" },
	subject: { type: "string", description: "Reviewer subject: spec, plan, unit, change or persona:<name>" },
};
