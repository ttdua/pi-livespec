// Classifies a `Verify` run as red, green or invalid, and what pre and post require.

import type { Unit } from "../core/change.ts";
import type { VerifyRun } from "./runner.ts";

export type RunClass = "red" | "green" | { invalid: "not-runnable" | "timeout" | "spawn" | "setup" | "aborted" };

/** The shell's exits for a command found but not executable (126) and a command not found (127). */
const NOT_RUNNABLE_EXITS: readonly number[] = [126, 127];

export function classifyRun(r: VerifyRun): RunClass {
	if (r.aborted) return { invalid: "aborted" };
	if (r.timedOut) return { invalid: "timeout" };
	if (r.spawnError !== undefined) return { invalid: "spawn" };
	// `null` without a timeout or abort: the shell was killed by a signal from outside.
	if (r.exit === null || NOT_RUNNABLE_EXITS.includes(r.exit)) return { invalid: "not-runnable" };
	return r.exit === 0 ? "green" : "red";
}

/** A refactor unit must already pass at pre; any other unit must fail. */
export function preExpectation(u: Unit): "red" | "green" {
	return u.kind === "refactor" ? "green" : "red";
}

/** Post requires green for every unit kind. */
export function postOk(c: RunClass): boolean {
	return c === "green";
}
