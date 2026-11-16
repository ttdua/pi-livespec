// Applying a rule `ask` answer (design D10): the `decision` record with
// `source: human` is the result comment; no other effect.

import { decisionComment, type DecisionRecord } from "../decide/records.ts";
import type { ApplyFn } from "./complete-effects.ts";
import { snapshotOf } from "./requests.ts";

export const applyDecide: ApplyFn = async (_run, record) => {
	const { request, answer } = record;
	const typed = snapshotOf(request);
	if (typed.kind !== "decide") throw new Error(`${request.subject} is not a decision request`);
	const s = typed.snapshot;
	const chosen = answer.outcome !== "dismissed" && answer.choice !== undefined;
	const decision: DecisionRecord = {
		point: s.point,
		subject: s.subject,
		source: "human",
		outcome: chosen ? answer.choice : null,
		facts: s.facts,
		...(s.digest === undefined ? {} : { digest: s.digest }),
		reason: chosen ? `chosen by ${answer.by}` : `dismissed by ${answer.by}`,
		request: request.id,
		...(s.proposal === true ? { proposal: true as const } : {}),
	};
	return decisionComment(decision);
};
