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

/** One effective value that differs from the request. */
export type Mismatch = { field: string; requested: string; effective: string };

export type LaunchCheck = { ok: true } | { ok: false; field: string; laneCwd: boolean; mismatches: Mismatch[] };

const show = (v: unknown): string => (v === undefined ? "unset" : Array.isArray(v) ? `[${v.join(", ")}]` : String(v));

const sameList = (a: readonly string[] | undefined, b: readonly string[]): boolean => a !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);

/** Every effective field that differs from the request; a missing event is the one mismatch `session-created`. */
function mismatches(requested: SpawnOptionsLike, facts: LaunchFacts | undefined): Mismatch[] {
	if (facts === undefined) return [{ field: "session-created", requested: "an event before the run settles", effective: "none" }];
	const out: Mismatch[] = [];
	const differ = (field: string, want: unknown, got: unknown, same: boolean): void => {
		if (!same) out.push({ field, requested: show(want), effective: show(got) });
	};
	differ("context", requested.context, facts.context, facts.context === requested.context);
	differ("cwd", requested.cwd, facts.cwd, facts.cwd === requested.cwd);
	differ("inheritSkills", requested.skills.inherit, facts.inheritSkills, facts.inheritSkills === requested.skills.inherit);
	differ("skillPaths", requested.skills.paths, facts.skillPaths, sameList(facts.skillPaths, requested.skills.paths));
	differ("contextFiles", requested.contextFiles, facts.contextFiles, facts.contextFiles === requested.contextFiles);
	const excluded = new Set(facts.excludedExtensionPackages ?? []);
	const covered = requested.excludeExtensionPackages.every((p) => excluded.has(p));
	differ("excludedExtensionPackages", requested.excludeExtensionPackages, facts.excludedExtensionPackages, covered);
	return out;
}

/** Compares the effective launch with the request; a `cwd`-only mismatch of a lane launch re-runs the unit sequentially. */
export function checkLaunch(requested: SpawnOptionsLike, facts?: LaunchFacts): LaunchCheck {
	const found = mismatches(requested, facts);
	const first = found[0];
	if (first === undefined) return { ok: true };
	const laneCwd = requested.metadata.lane !== undefined && found.length === 1 && first.field === "cwd";
	return { ok: false, field: first.field, laneCwd, mismatches: found };
}
