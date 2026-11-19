// Orchestration of one dispatch: watch → spawn → check → wait → interpret → record. Counters come from forge records only.

import type { LaunchFacts, RecordLike, SubagentsServiceLike } from "./executor.ts";
import { checkLaunch, type EventsLike, type Mismatch, spawnOptions, watchLaunch } from "./launch.ts";
import { dispatchComment, type QuestionLaunch, type Thinking } from "./records.ts";
import { type DispatchHistory, interpret, type ResultDecision } from "./result.ts";
import { AGENT_OF, type ReviewSubject, type Role, type SubagentEntry, type SubagentResult } from "./roles.ts";
import { blockedResult, LAUNCH_MISMATCH, mismatchComment, recordResult, type RecordDeps, type RunFacts } from "./run-record.ts";
import type { Packet } from "./source-types.ts";

export type DispatchOutcome =
	| { kind: "result"; result: SubagentResult; facts: LaunchFacts; sourcesNamed?: string[] }
	| { kind: "question"; id: string; text: string }
	| { kind: "inline"; reason: string; packet: Packet }
	| { kind: "sequential"; reason: string }
	| { kind: "blocked"; reason: string; result?: SubagentResult }
	| { kind: "stuck"; reason: string; result?: SubagentResult };

export type AgentInfo = { name: string; source: string; filePath?: string };

/** The side effects a dispatch needs; the tools wire them to the session, the forge and git. */
export type DispatchDeps = RecordDeps & {
	service: SubagentsServiceLike;
	events: EventsLike;
	/** Called for a role agent that is not the executor's built-in. */
	onOverride(agent: AgentInfo): void;
};

export type DispatchRequest = {
	role: Role;
	unit?: string;
	subject?: ReviewSubject;
	entry?: SubagentEntry;
	packet: Packet;
	change: string;
	lane?: string;
	difficulty: Thinking;
	failedAttempts: number;
	exclusions: string[];
	attempt: number;
	round: number;
	needsContext: number;
};

const BUILTIN_SOURCE = "builtin";

/** One launch's identity and the facts the record needs. */
export type Run = { agentId: string; facts: LaunchFacts; thinking: Thinking; agentSource: string };

type Launched = { kind: "settled"; run: Run; record: RecordLike } | { kind: "stop"; outcome: DispatchOutcome };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function runFacts(request: DispatchRequest, run: Run): RunFacts {
	return {
		role: request.role, ...(request.unit === undefined ? {} : { unit: request.unit }), ...(request.subject === undefined ? {} : { subject: request.subject }),
		agentId: run.agentId, attempt: request.attempt, round: request.round, packet: request.packet, agentSource: run.agentSource,
		requested: { thinking: run.thinking },
		effective: { ...(run.facts.effectiveModel === undefined ? {} : { model: run.facts.effectiveModel }), ...(run.facts.effectiveThinking === undefined ? {} : { thinking: run.facts.effectiveThinking }) },
		advisory: request.entry?.advisory === true, needsContext: request.needsContext,
	};
}

/** The role's agent, or the inline outcome when the executor reports it disabled. */
function agentFor(deps: DispatchDeps, request: DispatchRequest): AgentInfo | DispatchOutcome {
	const name = AGENT_OF[request.role];
	const agent = deps.service.getAgentType(name);
	if (agent === undefined) return { kind: "inline", reason: `the ${name} agent is disabled in the executor, so ${request.role} runs inline`, packet: request.packet };
	if (agent.source !== BUILTIN_SOURCE) deps.onOverride(agent);
	return agent;
}

/** Waits for the run while the watcher waits for `session-created`; the watcher gives up once the run settles. */
async function waitWithFacts(deps: DispatchDeps, agentId: string, watch: ReturnType<typeof watchLaunch>, settled: AbortController): Promise<{ facts: LaunchFacts | undefined; waited: Promise<RecordLike> }> {
	const waited = deps.service.wait(agentId);
	waited.then(() => settled.abort(), () => settled.abort());
	return { facts: await watch.factsFor(agentId), waited };
}

/** Spawns one child and checks its effective launch before waiting for its result. */
async function launch(deps: DispatchDeps, request: DispatchRequest, agentSource: string): Promise<Launched> {
	const options = spawnOptions(request.packet, request.role, request.entry, request.difficulty, request.failedAttempts, request.exclusions, {
		change: request.change, ...(request.unit === undefined ? {} : { unit: request.unit }), ...(request.subject === undefined ? {} : { subject: request.subject }), ...(request.lane === undefined ? {} : { lane: request.lane }),
	});
	const settled = new AbortController();
	const watch = watchLaunch(deps.events, settled.signal);
	try {
		let agentId: string;
		try {
			agentId = deps.service.spawn(AGENT_OF[request.role], request.packet.text, options);
		} catch (error) {
			return { kind: "stop", outcome: { kind: "inline", reason: `the executor refused the launch: ${messageOf(error)}; ${request.role} runs inline`, packet: request.packet } };
		}
		const { facts, waited } = await waitWithFacts(deps, agentId, watch, settled);
		const run: Run = { agentId, facts: facts ?? { context: "unknown", cwd: "unknown" }, thinking: options.thinkingLevel, agentSource };
		const check = checkLaunch(options, facts);
		if (!check.ok) return { kind: "stop", outcome: await mismatchOutcome(deps, request, run, check, waited) };
		return { kind: "settled", run, record: await waited.catch((error: unknown): RecordLike => ({ id: agentId, status: "error", error: messageOf(error) })) };
	} finally {
		watch.dispose();
	}
}

/** `field: requested X, effective Y` for each mismatch: the evidence of a `launch-mismatch` record. */
const mismatchEvidence = (found: Mismatch[]): string => found.map((m) => `${m.field}: requested ${m.requested}, effective ${m.effective}`).join("; ");

/** Aborts the child, records the mismatch as `BLOCKED` `launch-mismatch` (not a failed attempt), then runs inline or sequentially. */
async function mismatchOutcome(deps: DispatchDeps, request: DispatchRequest, run: Run, check: { field: string; laneCwd: boolean; mismatches: Mismatch[] }, waited: Promise<RecordLike>): Promise<DispatchOutcome> {
	deps.service.abort(run.agentId);
	waited.catch(() => undefined);
	const evidence = mismatchEvidence(check.mismatches);
	await deps.post(mismatchComment(runFacts(request, run), `The executor did not apply the launch as requested; child ${run.agentId} was aborted.`, evidence));
	if (check.laneCwd) return { kind: "sequential", reason: `child ${run.agentId} was aborted: its effective cwd differs from the lane (${evidence}); re-run ${request.unit} sequentially` };
	return { kind: "inline", reason: `child ${run.agentId} was aborted, ${LAUNCH_MISMATCH} recorded (mismatch: ${evidence}); ${request.role} runs inline`, packet: request.packet };
}

/** The data a later `subagent_answer` needs to record the resumed run as this dispatch would have. */
function questionLaunch(facts: RunFacts): QuestionLaunch {
	return { packet: facts.packet.hash, agentSource: facts.agentSource, requested: facts.requested, effective: facts.effective, advisory: facts.advisory };
}

/** Records a decision that ends the dispatch, and turns it into the outcome. */
async function finish(deps: DispatchDeps, run: RunFacts, cwd: string, facts: LaunchFacts, decision: Exclude<ResultDecision, { kind: "retry" } | { kind: "return" }>): Promise<DispatchOutcome> {
	switch (decision.kind) {
		case "question":
			await deps.post(dispatchComment({ status: "QUESTION", role: run.role, ...(run.unit === undefined ? {} : { unit: run.unit }), ...(run.subject === undefined ? {} : { subject: run.subject }), agentId: run.agentId as string, attempt: run.attempt, question: decision.text, launch: questionLaunch(run) }));
			return { kind: "question", id: run.agentId as string, text: decision.text };
		case "blocked":
			await recordResult(deps, run, cwd, blockedResult(decision.reason));
			return { kind: "blocked", reason: decision.reason };
		case "stuck": {
			const result = await recordResult(deps, run, cwd, decision.result ?? blockedResult(decision.reason));
			return { kind: "stuck", reason: decision.reason, result };
		}
		case "more-context":
			return { kind: "result", result: await recordResult(deps, run, cwd, decision.result), facts, sourcesNamed: decision.ids };
		case "accept":
			return { kind: "result", result: await recordResult(deps, run, cwd, decision.result), facts };
	}
}

/** Resumes the child naming the missing sources and waits for its next run; a refused resume blocks. */
async function returnToChild(deps: DispatchDeps, agentId: string, missing: string[]): Promise<RecordLike | string> {
	const message = `Your result omits required sources from sources_used: ${missing.join(", ")}. Read them, then submit your result again listing every source you used.`;
	try {
		const resumed = (await deps.service.resume(agentId, message)) as { kind?: string; reason?: string } | undefined;
		if (resumed?.kind === "refused") return `the executor refused to resume ${agentId}: ${resumed.reason ?? "no reason"}`;
		return await deps.service.wait(agentId);
	} catch (error) {
		return `resuming ${agentId} failed: ${messageOf(error)}`;
	}
}

/** Interprets settled runs until one ends the dispatch: a retry relaunches with the same packet, a return resumes the child once. */
export async function settle(deps: DispatchDeps, request: DispatchRequest, first: { run: Run; record: RecordLike }, history: DispatchHistory): Promise<DispatchOutcome> {
	let { run, record } = first;
	let seen = history;
	for (;;) {
		const facts = runFacts(request, run);
		const decision = interpret(record, request.packet, request.role, seen);
		if (decision.kind === "retry") {
			const again = await launch(deps, request, run.agentSource);
			if (again.kind === "stop") return again.outcome;
			({ run, record } = again);
			seen = { ...seen, retries: seen.retries + 1 };
			continue;
		}
		if (decision.kind === "return") {
			const next = await returnToChild(deps, run.agentId, decision.missing);
			if (typeof next === "string") return finish(deps, facts, request.packet.cwd, run.facts, { kind: "blocked", reason: next });
			record = next;
			seen = { ...seen, returns: seen.returns + 1 };
			continue;
		}
		return finish(deps, facts, request.packet.cwd, run.facts, decision);
	}
}

/** One dispatch: the role's agent, a checked launch, then the interpreted result. */
export async function runDispatch(deps: DispatchDeps, request: DispatchRequest): Promise<DispatchOutcome> {
	const agent = agentFor(deps, request);
	if ("kind" in agent) return agent;
	const launched = await launch(deps, request, agent.source);
	if (launched.kind === "stop") return launched.outcome;
	return settle(deps, request, launched, { needsContext: request.needsContext, retries: 0, returns: 0 });
}

/** A run resumed by `subagent_answer`: its launch facts come from the `QUESTION` record. */
export function resumedRun(agentId: string, cwd: string, launch: QuestionLaunch | undefined, fallback: Thinking): Run {
	const effective = launch?.effective ?? {};
	return {
		agentId,
		thinking: launch?.requested.thinking ?? fallback,
		agentSource: launch?.agentSource ?? "unknown",
		facts: { context: "fresh", cwd, ...(effective.model === undefined ? {} : { effectiveModel: effective.model }), ...(effective.thinking === undefined ? {} : { effectiveThinking: effective.thinking }) },
	};
}
