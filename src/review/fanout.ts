// Runs several dispatches at the same time (design D1): each `runDispatch` spawns before its first await,
// so every child is launched before any is waited for. The dispatches share the tool call's signal.

import { cancelledOutcome, type DispatchOutcome } from "../subagents/dispatch.ts";

export function fanOut(runs: (() => Promise<DispatchOutcome>)[], signal?: AbortSignal): Promise<PromiseSettledResult<DispatchOutcome>[]> {
	if (signal?.aborted === true) return Promise.resolve(runs.map(() => ({ status: "fulfilled" as const, value: cancelledOutcome(undefined) })));
	return Promise.allSettled(runs.map((run) => run()));
}
