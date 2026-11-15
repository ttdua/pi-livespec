// Pure upgrade policy for the agent-skills clone.

import type { Channel } from "../config.ts";
import type { Lock } from "./lock.ts";
import type { WorkInProgress } from "./wip.ts";

export type UpgradeInput = { channel: Channel; lock: Lock; now: Date; head: string; workInProgress: WorkInProgress; manual: boolean };
export type SkipDecision = { kind: "skip"; reason: string };
export type UpgradeDecision = SkipDecision | { kind: "notify"; sha: string } | { kind: "install"; sha: string };

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const skip = (reason: string): SkipDecision => ({ kind: "skip", reason });

/**
 * The rules that need no upstream head: pin, the 24-hour throttle (automatic only) and work in progress.
 * `undefined` means a fetch is worth making.
 */
export function upgradeGate(i: Omit<UpgradeInput, "head">): SkipDecision | undefined {
	const pin = i.lock.pinned;
	if (pin !== null || i.channel === "pinned") {
		const what = pin !== null ? `pinned at ${pin}` : "the channel is pinned";
		return skip(i.manual ? `agent-skills is ${what}; unpin first` : `agent-skills is ${what}`);
	}
	if (!i.manual && isThrottled(i.lock.checkedAt, i.now)) return skip("checked less than 24 hours ago");
	if (i.workInProgress.busy) return skip(workInProgressReason(i.workInProgress));
	return undefined;
}

export function decideUpgrade(i: UpgradeInput): UpgradeDecision {
	const gate = upgradeGate(i);
	if (gate) return gate;
	if (i.head === i.lock.commit) return skip(`already at ${i.head}`);
	if (i.lock.skipped.includes(i.head)) return skip(`${i.head} was rolled back and is skipped`);
	if (i.channel === "notify" && !i.manual) return { kind: "notify", sha: i.head };
	return { kind: "install", sha: i.head };
}

function isThrottled(checkedAt: string | null, now: Date): boolean {
	if (checkedAt === null) return false;
	const last = Date.parse(checkedAt);
	return !Number.isNaN(last) && now.getTime() - last < CHECK_INTERVAL_MS;
}

export function workInProgressReason(wip: WorkInProgress): string {
	const what = wip.change !== undefined ? `change #${wip.change}` : "a change";
	return `work in progress (${what}${wip.reason ? `: ${wip.reason}` : ""}); no upgrade until it finishes`;
}
