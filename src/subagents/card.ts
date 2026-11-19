// The `subagents` card section: the suggested dispatch or inline step, and a child waiting on an answer.

import { type CardSection, registerCardSection, untrusted } from "../hooks/phase-card.ts";

const argsOf = (d: { role: string; unit?: string; subject?: string }): string => [d.role, d.unit, d.subject].filter((p) => p !== undefined).join(" ");

export const subagentsSection: CardSection = (i) => {
	if (i.kind !== "change") return undefined;
	const { dispatch, pendingChild } = i.step;
	const lines: string[] = [];
	if (pendingChild) lines.push(`Child ${pendingChild.agentId} waits for an answer: ${untrusted(pendingChild.question)}`);
	if (dispatch) {
		const args = argsOf(dispatch);
		lines.push(dispatch.inline ? `Subagent step (inline): subagent_packet ${args}, then subagent_record ${args}` : `Subagent step: subagent_dispatch ${args}`);
	}
	return lines.length === 0 ? undefined : lines.join("\n");
};

registerCardSection("subagents", subagentsSection);
