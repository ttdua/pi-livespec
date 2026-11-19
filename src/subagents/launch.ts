// Launch side of a dispatch: the spawn options, the `session-created` watcher (subscribed before spawn) and the post-launch check.

import { type LaunchFacts, parseLaunchFacts, type SpawnOptionsLike } from "./executor.ts";
import type { Thinking } from "./records.ts";
import { resultSchema, type Role, type SubagentEntry } from "./roles.ts";
import type { Packet } from "./source-types.ts";

export const SESSION_CREATED = "subagents:child:session-created";

const LEVELS: readonly Thinking[] = ["low", "medium", "high"];

/** The structural part of pi's event bus a dispatch needs. */
export type EventsLike = { on(channel: string, handler: (data: unknown) => void): () => void };

/** `owner`, `change`, `role` and `packet` always; the rest when they apply. */
export type LaunchMetadata = { change: string; unit?: string; subject?: string; lane?: string };

/** The dispatched `Difficulty`, raised one step per failed attempt, capped at `high`. */
export function raisedThinking(difficulty: Thinking, failedAttempts: number): Thinking {
	const at = Math.min(LEVELS.indexOf(difficulty) + Math.max(failedAttempts, 0), LEVELS.length - 1);
	return LEVELS[at] as Thinking;
}

/** Every launch: fresh context, no context files, the role's skills only, the isolation list, and never a model. */
export function spawnOptions(
	packet: Packet,
	role: Role,
	entry: SubagentEntry | undefined,
	difficulty: Thinking,
	attempts: number,
	exclusions: string[],
	metadata: LaunchMetadata,
): SpawnOptionsLike {
	const thinking = raisedThinking(difficulty, attempts);
	const subject = entry?.subject ?? metadata.subject;
	const meta: Record<string, string> = { owner: "livespec", change: metadata.change, role, packet: packet.hash };
	if (metadata.unit !== undefined) meta.unit = metadata.unit;
	if (subject !== undefined) meta.subject = subject;
	if (metadata.lane !== undefined) meta.lane = metadata.lane;
	meta.difficulty = difficulty;
	return {
		description: `livespec ${[role, metadata.unit, subject].filter((p) => p !== undefined).join(" ")}`,
		context: "fresh",
		contextFiles: false,
		thinkingLevel: thinking,
		metadata: meta,
		skills: { inherit: false, paths: [...packet.skillPaths] },
		excludeExtensionPackages: [...exclusions],
		cwd: packet.cwd,
		resultSchema: resultSchema(role),
	};
}

export type LaunchWatch = { factsFor(agentId: string): Promise<LaunchFacts | undefined>; dispose(): void };

/**
 * Subscribes to `session-created` before `spawn`, so an event emitted during `spawn` is buffered.
 * `factsFor` resolves with the agent's facts, or `undefined` once `signal` aborts (the run settled first).
 */
export function watchLaunch(events: EventsLike, signal: AbortSignal): LaunchWatch {
	const seen = new Map<string, LaunchFacts>();
	const waiting = new Map<string, (facts: LaunchFacts | undefined) => void>();
	const off = events.on(SESSION_CREATED, (payload) => {
		const parsed = parseLaunchFacts(payload);
		if (parsed === undefined || seen.has(parsed.agentId)) return;
		seen.set(parsed.agentId, parsed.facts);
		waiting.get(parsed.agentId)?.(parsed.facts);
	});
	const settleAll = (): void => {
		for (const resolve of waiting.values()) resolve(undefined);
	};
	signal.addEventListener("abort", settleAll, { once: true });
	return {
		factsFor(agentId) {
			const known = seen.get(agentId);
			if (known !== undefined || signal.aborted) return Promise.resolve(known);
			return new Promise((resolve) => waiting.set(agentId, resolve));
		},
		dispose() {
			off();
			signal.removeEventListener("abort", settleAll);
			settleAll();
		},
	};
}

export type LaunchCheck = { ok: true } | { ok: false; field: string; laneCwd: boolean };

const sameList = (a: readonly string[] | undefined, b: readonly string[]): boolean => a !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);

/** The first effective field that differs from the request; a missing event is a mismatch named `session-created`. */
function mismatch(requested: SpawnOptionsLike, facts: LaunchFacts | undefined): string | undefined {
	if (facts === undefined) return "session-created";
	if (facts.context !== requested.context) return "context";
	if (facts.cwd !== requested.cwd) return "cwd";
	if (facts.inheritSkills !== requested.skills.inherit) return "inheritSkills";
	if (!sameList(facts.skillPaths, requested.skills.paths)) return "skillPaths";
	if (facts.contextFiles !== requested.contextFiles) return "contextFiles";
	const excluded = new Set(facts.excludedExtensionPackages ?? []);
	if (!requested.excludeExtensionPackages.every((p) => excluded.has(p))) return "excludedExtensionPackages";
	return undefined;
}

/** Compares the effective launch with the request; a `cwd` mismatch of a lane launch re-runs the unit sequentially. */
export function checkLaunch(requested: SpawnOptionsLike, facts?: LaunchFacts): LaunchCheck {
	const field = mismatch(requested, facts);
	if (field === undefined) return { ok: true };
	return { ok: false, field, laneCwd: field === "cwd" && requested.metadata.lane !== undefined };
}
