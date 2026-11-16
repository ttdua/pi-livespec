// `/livespec next`: the same next-step text as the `spec_next` tool.

import type { Session } from "../hooks/session.ts";
import { pollApprovals } from "../interaction/poll.ts";
import { formatOpenChanges, formatStep } from "../tools/format-step.ts";
import { readCurrentChange } from "../tools/read-change.ts";

export async function runNextCommand(session: Session): Promise<string> {
	await pollApprovals(session);
	const current = await readCurrentChange(session);
	if (current.kind === "change") return formatStep(current.step, current.state);
	if (current.kind === "list") return formatOpenChanges(current.open);
	return current.message;
}
