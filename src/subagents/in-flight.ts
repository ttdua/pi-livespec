// Registry of live dispatches by target: one running child per target. Module state; lives as long as the process.

import type { QuestionTarget } from "./records.ts";

const LAUNCHING = "(launching)";

const running = new Map<string, string>();

/** Identifies a target within a change: issue number plus role, unit, subject and finding. */
export const targetKey = (issue: number, t: QuestionTarget): string => JSON.stringify([issue, t.role, t.unit ?? null, t.subject ?? null, t.finding ?? null]);

/** Free → claims the target and returns undefined; taken → the running agent id (or `"(launching)"`). */
export function claim(key: string): string | undefined {
	const held = running.get(key);
	if (held !== undefined) return held;
	running.set(key, LAUNCHING);
	return undefined;
}

export function update(key: string, agentId: string): void {
	running.set(key, agentId);
}

export function release(key: string): void {
	running.delete(key);
}

/** Tests only. */
export function clearInFlight(): void {
	running.clear();
}
