// Orchestration of one dispatch: watch → spawn → check → wait → interpret → record. Counters come from forge records only.

import { BUILTIN_SOURCE, type LaunchFacts, type RecordLike, type SubagentsServiceLike } from "./executor.ts";
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
	| { kind: "stuck"; reason: string; result?: SubagentResult }
	| { kind: "cancelled"; reason: string };

export type AgentInfo = { name: string; source: string; filePath?: string };

/** The side effects a dispatch needs; the tools wire them to the session, the forge and git. */
export type DispatchDeps = RecordDeps & {
	service: SubagentsServiceLike;
	events: EventsLike;
	/** Called for a role agent that is not the executor's built-in. */
	onOverride(agent: AgentInfo): void;
	/** The tool call's signal: passed to every `wait`; when it aborts, the child is aborted and nothing more is recorded. */
	signal?: AbortSignal;
	/** How long to wait for an aborted child to settle before the forge write; defaults to `ABORT_SETTLE_MS`. */
	abortSettleMs?: number;
};

/** Bound on waiting for an aborted child to settle. */
export const ABORT_SETTLE_MS = 30_000;

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
	/** The aggregate finding key a verifier checks. */
	finding?: string;
};

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
		...(request.finding === undefined ? {} : { finding: request.finding }),
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

/** Aborts child `agentId` when `signal` aborts (the user cancelled the tool call); returns the listener's disposer. */
export function abortChildOnCancel(service: SubagentsServiceLike, agentId: string, signal: AbortSignal | undefined): () => void {
	if (signal === undefined) return () => undefined;
	const stop = (): void => {
		service.abort(agentId);
	};
	if (signal.aborted) stop();
	else signal.addEventListener("abort", stop, { once: true });
	return () => signal.removeEventListener("abort", stop);
}

/** The outcome of a tool call the user cancelled: the child is aborted and no result is recorded. */
export const cancelledOutcome = (agentId: string | undefined): DispatchOutcome => ({
	kind: "cancelled",
	reason: agentId === undefined ? "the call was cancelled before any child was launched" : `the call was cancelled, so child ${agentId} was aborted and no result was recorded`,
});

/** Read through a function: TypeScript narrows `signal.aborted` after an earlier check, but a cancel can arrive at any await. */
export const isCancelled = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/** `wait` with the tool call's signal, so a cancel stops waiting at once. */
export const waitFor = (service: SubagentsServiceLike, agentId: string, signal: AbortSignal | undefined): Promise<RecordLike> =>
	service.wait(agentId, signal === undefined ? undefined : { signal });

/** Waits for the run while the watcher waits for `session-created`; the watcher gives up once the run settles. */
async function waitWithFacts(deps: DispatchDeps, agentId: string, watch: ReturnType<typeof watchLaunch>, settled: AbortController): Promise<{ facts: LaunchFacts | undefined; waited: Promise<RecordLike> }> {
	const waited = waitFor(deps.service, agentId, deps.signal);
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
	let disposeCancel = (): void => undefined;
	try {
		let agentId: string;
		try {
			agentId = deps.service.spawn(AGENT_OF[request.role], request.packet.text, options);
		} catch (error) {
			return { kind: "stop", outcome: { kind: "inline", reason: `the executor refused the launch: ${messageOf(error)}; ${request.role} runs inline`, packet: request.packet } };
		}
		disposeCancel = abortChildOnCancel(deps.service, agentId, deps.signal);
		const { facts, waited } = await waitWithFacts(deps, agentId, watch, settled);
		if (isCancelled(deps.signal)) {
			waited.catch(() => undefined);
			return { kind: "stop", outcome: cancelledOutcome(agentId) };
		}
		const run: Run = { agentId, facts: facts ?? { context: "unknown", cwd: "unknown" }, thinking: options.thinkingLevel, agentSource };
		const check = checkLaunch(options, facts);
		if (!check.ok) return { kind: "stop", outcome: await mismatchOutcome(deps, request, run, check, waited) };
		return { kind: "settled", run, record: await waited.catch((error: unknown): RecordLike => ({ id: agentId, status: "error", error: messageOf(error) })) };
	} finally {
		disposeCancel();
		watch.dispose();
	}
}

/** `field: requested X, effective Y` for each mismatch: the evidence of a `launch-mismatch` record. */
const mismatchEvidence = (found: Mismatch[]): string => found.map((m) => `${m.field}: requested ${m.requested}, effective ${m.effective}`).join("; ");

/** True once `run` settles (a rejection counts as settled), false when `ms` pass first. */
async function settledWithin(run: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
	try {
		return await Promise.race([run.then(() => true, () => true), expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** Aborts the child, waits (bounded) for it to settle, records the mismatch as `BLOCKED` `launch-mismatch` (not a failed attempt) only once it settled, then runs inline or sequentially. */
async function mismatchOutcome(deps: DispatchDeps, request: DispatchRequest, run: Run, check: { field: string; laneCwd: boolean; mismatches: Mismatch[] }, waited: Promise<RecordLike>): Promise<DispatchOutcome> {
	deps.service.abort(run.agentId);
	const limit = deps.abortSettleMs ?? ABORT_SETTLE_MS;
	const confirmed = await settledWithin(waited, limit);
	if (isCancelled(deps.signal)) return cancelledOutcome(run.agentId);
	const found = mismatchEvidence(check.mismatches);
	// The tool never writes to the forge before the child's run has settled.
	const note = confirmed ? "" : `; the mismatch was not recorded: child ${run.agentId} did not settle within ${limit / 1000} s of the abort`;
	if (confirmed) await deps.post(mismatchComment(runFacts(request, run), `The executor did not apply the launch as requested; child ${run.agentId} was aborted.`, found));
	if (check.laneCwd) return { kind: "sequential", reason: `child ${run.agentId} was aborted: its effective cwd differs from the lane (${found})${note}; re-run ${request.unit} sequentially` };
	const recorded = confirmed ? `${LAUNCH_MISMATCH} recorded` : "no record written";
	return { kind: "inline", reason: `child ${run.agentId} was aborted, ${recorded} (mismatch: ${found})${note}; ${request.role} runs inline`, packet: request.packet };
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
	const disposeCancel = abortChildOnCancel(deps.service, agentId, deps.signal);
	try {
		const resumed = (await deps.service.resume(agentId, message)) as { kind?: string; reason?: string } | undefined;
		if (resumed?.kind === "refused") return `the executor refused to resume ${agentId}: ${resumed.reason ?? "no reason"}`;
		return await waitFor(deps.service, agentId, deps.signal);
	} catch (error) {
		return `resuming ${agentId} failed: ${messageOf(error)}`;
	} finally {
		disposeCancel();
	}
}

/** Interprets settled runs until one ends the dispatch: a retry relaunches with the same packet, a return resumes the child once. */
export async function settle(deps: DispatchDeps, request: DispatchRequest, first: { run: Run; record: RecordLike }, history: DispatchHistory): Promise<DispatchOutcome> {
	let { run, record } = first;
	let seen = history;
	for (;;) {
		if (isCancelled(deps.signal)) return cancelledOutcome(run.agentId);
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
			if (isCancelled(deps.signal)) return cancelledOutcome(run.agentId);
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
	if (isCancelled(deps.signal)) return cancelledOutcome(undefined);
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
