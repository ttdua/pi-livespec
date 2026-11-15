// The decision seam: runs the registered rule for a point and, when the rule
// asks, hands the question to the caller's approver. It never writes anything.

import { ruleFor } from "./registry.ts";

export type DecisionAsk = {
	point: string;
	subject: string;
	facts: unknown;
	summary: string;
	options: { id: string; label: string }[];
};

/** Structurally compatible with the approver's `Answered` (only the fields the seam reads). */
export type AskAnswered = { status: "answered"; outcome: string; choice?: string; by: string; at: string };
export type AskPending = { status: "pending"; requestId: string };

export type DecideDeps = {
	config: unknown;
	subject: string;
	ask?: (intent: DecisionAsk) => Promise<AskAnswered | AskPending>;
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
	const answer = await deps.ask({ point, subject: deps.subject, facts, ...result.ask });
	if (answer.status === "pending") return { status: "pending", requestId: answer.requestId };
	if (answer.choice === undefined) {
		throw new Error(`decision \`${point}.${deps.subject}\` got answer \`${answer.outcome}\` without a choice`);
	}
	return { status: "decided", outcome: answer.choice, source: "human", reason: `${answer.by} chose ${answer.choice} at ${answer.at}`, facts };
}
