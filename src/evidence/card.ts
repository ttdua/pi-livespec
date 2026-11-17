// The `evidence` card section: started units with their pre SHA, blocked units with their reason and
// verifier-pending units. It reads only the change state and the next step, and is pure.

import { type CardSection, registerCardSection } from "../hooks/phase-card.ts";

const SHORT_SHA = 7;

export const evidenceSection: CardSection = (i) => {
	if (i.kind !== "change") return undefined;
	const { started } = i.state.evidence;
	const lines = [
		...i.step.startedUnits.map((id) => `Started: ${id} at ${(started[id]?.pre.sha ?? "").slice(0, SHORT_SHA)}`),
		...i.step.blockedUnits.map((b) => `BLOCKED: ${b.id} (reason ${b.reason})`),
		...i.step.pendingVerifier.map((id) => `Verifier pending: ${id}`),
	];
	return lines.length === 0 ? undefined : lines.join("\n");
};

registerCardSection("evidence", evidenceSection);
