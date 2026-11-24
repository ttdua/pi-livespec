// The `behavior-change` question at `spec_gate define|review` (durable-doc-checks "Behavior change question at the
// gate", design D4): for each behavior item without a reusable record, `decide` asks through the approver chain,
// one capability at a time. The caller has already evaluated every other refusal, so this is the only write
// before the gate request.

import { messageOf } from "../core/messages.ts";
import { decide } from "../decide/seam.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { displayRequestId } from "../interaction/display-ids.ts";
import type { ApproverCtx } from "../tools/approver-for.ts";
import { createDecisionAsker } from "../tools/decide-ask.ts";
import type { WriteContext } from "../tools/guard.ts";
import { BEHAVIOR_POINT, type BehaviorItem, behaviorAnswer, behaviorDigest, behaviorSubject, changeBehaviorItems } from "./behavior-change.ts";

export type BehaviorAskResult = { ok: true; asked: boolean } | { ok: false; message: string };

const DEFAULT_CONFIG = { mode: "rule" };

/** Asks every unanswered behavior item; refuses on the first pending request or approver failure. */
export async function askBehaviorChanges(w: WriteContext, state: ChangeState, ctx: ApproverCtx): Promise<BehaviorAskResult> {
	const items = await changeBehaviorItems(w.session.cwd, w.session.git, state.change.header.base);
	const unanswered = items.filter((item) => behaviorAnswer(state.marked, item) === undefined);
	const ask = createDecisionAsker(w, state, ctx);
	const config = w.pack.decisions[BEHAVIOR_POINT] ?? DEFAULT_CONFIG;
	for (const item of unanswered) {
		const refusal = await askOne(item, config, ask);
		if (refusal !== undefined) return { ok: false, message: refusal };
	}
	return { ok: true, asked: unanswered.length > 0 };
}

/** One capability's question; a refusal text when it is pending or cannot be asked. */
async function askOne(item: BehaviorItem, config: unknown, ask: ReturnType<typeof createDecisionAsker>): Promise<string | undefined> {
	const subject = behaviorSubject(item.capability);
	try {
		const decided = await decide(BEHAVIOR_POINT, item, { config, subject: item.capability, digest: behaviorDigest(item.files), ask });
		if (decided.status === "decided") return undefined;
		return `spec_gate refused: ${subject} waits for the human's answer (request ${displayRequestId(decided.requestId)}); no gate request was sent. Run spec_gate again once it is answered.`;
	} catch (error) {
		return `spec_gate refused: ${messageOf(error)}; no gate request was sent.`;
	}
}
