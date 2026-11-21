// The forge writes of `change_ship` after the push (design D5): the `PR:` ownership line and the `ship` record.

import { messageOf } from "../core/messages.ts";
import { setHeaderLine } from "../core/sections.ts";
import type { Forge } from "../forge/types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { writeBodyWithRetry } from "./versioned-write.ts";
import { type ShipRecord, shipComment } from "./records.ts";

const PR_KEY = "PR";

export type WriteOutcome = { ok: true } | { ok: false; message: string };

/** Writes `PR: #<pr>` with a versioned body write; one retry after re-reading when the issue changed. */
export async function writePrLine(forge: Pick<Forge, "getIssue" | "updateIssueBody">, issue: number, pr: number): Promise<WriteOutcome> {
	const rerun = `the pull request #${pr} is open; run change_ship again to record it.`;
	try {
		const written = await writeBodyWithRetry(forge, issue, (body) => setHeaderLine(body, PR_KEY, `#${pr}`));
		if (written.status !== "conflict") return { ok: true };
		return { ok: false, message: `the issue #${issue} kept changing while PR: #${pr} was written; ${rerun}` };
	} catch (error) {
		return { ok: false, message: `writing PR: #${pr} to #${issue} failed (${untrusted(messageOf(error))}); ${rerun}` };
	}
}

/** Posts the own `ship` record; a failure is reported, since the `PR:` line is already written. */
export async function postShipRecord(forge: Pick<Forge, "createComment">, issue: number, record: ShipRecord, done = `PR: #${record.pr} is recorded`, next = "change_push records the next pushed head"): Promise<WriteOutcome> {
	try {
		await forge.createComment(issue, shipComment(record));
		return { ok: true };
	} catch (error) {
		return { ok: false, message: `${done}, but posting the ship record failed (${untrusted(messageOf(error))}); ${next}.` };
	}
}
