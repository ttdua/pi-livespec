// The decision seam: runs the registered rule for a point and, when the rule
// asks, hands the question to the caller's approver. It never writes anything.

import { ruleFor } from "./registry.ts";

export type DecisionAsk = {
	point: string;
	subject: string;
	digest?: string;
	facts: unknown;
	summary: string;
	options: { id: string; label: string }[];
};

/** Structurally compatible with the approver's `Answered` (only the fields the seam reads). */
export type AskAnswered = { status: "answered"; outcome: string; choice?: string; by: string; at: string };
export type AskPending = { status: "pending"; requestId: string };

/** An answer the asker reused from a human record for the same unit digest and facts. */
export type AskRecorded = { status: "recorded"; outcome: unknown; reason: string };

export type DecideDeps = {
	config: unknown;
	subject: string;
	digest?: string;
	ask?: (intent: DecisionAsk) => Promise<AskAnswered | AskPending | AskRecorded>;
};

export type Decided = {
	status: "decided";
	outcome: unknown;
	source: "rule" | "human";
	reason: string;
	facts: unknown;
	data?: { agentAdditions?: string[] };
};

/** Runs the rule for `point`; an `ask` goes to `deps.ask`. Throws on an unregistered point, a missing approver or an answer without a choice. */
export async function decide(point: string, facts: unknown, deps: DecideDeps): Promise<Decided | AskPending> {
	const rule = ruleFor(point);
	if (!rule) throw new Error(`no rule is registered for decision point \`${point}\``);
	const result = rule.fn(facts, deps.config);
	if (!("ask" in result)) {
		const decided: Decided = { status: "decided", outcome: result.outcome, source: "rule", reason: result.reason, facts };
		if (result.data) decided.data = result.data;
		return decided;
	}
	if (!deps.ask) throw new Error(`decision point \`${point}\` asks a human but no approver was given`);
	const digest = deps.digest === undefined ? {} : { digest: deps.digest };
	const answer = await deps.ask({ point, subject: deps.subject, facts, ...digest, ...result.ask });
	if (answer.status === "pending") return { status: "pending", requestId: answer.requestId };
	if (answer.status === "recorded") return { status: "decided", outcome: answer.outcome, source: "human", reason: answer.reason, facts };
	if (answer.choice === undefined) {
		throw new Error(`decision \`${point}.${deps.subject}\` got answer \`${answer.outcome}\` without a choice`);
	}
	return { status: "decided", outcome: answer.choice, source: "human", reason: `${answer.by} chose ${answer.choice} at ${answer.at}`, facts };
}
