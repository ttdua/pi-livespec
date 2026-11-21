// Reads the pull request a change's `PR:` line names. Pull request reads are not cached, so a
// read-only session skips the read and says so instead of calling the forge.

import type { Change } from "../core/change.ts";
import type { Git } from "../engine/git.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { isOffline } from "../forge/errors.ts";
import type { Forge } from "../forge/types.ts";

export type PullRequestFacts = { pr?: NonNullable<ChangeState["pr"]>; warnings: string[] };

const PR_VALUE = /^#(\d+)$/;

/** The pull request number of a `PR:` value such as `#41`; undefined when malformed. */
export function parsePrNumber(value: string): number | undefined {
	const m = PR_VALUE.exec(value.trim());
	const n = m ? Number(m[1]) : Number.NaN;
	return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export async function readPullRequest(forge: Forge, git: Git, header: Change["header"], branch: string | undefined, readOnly = false): Promise<PullRequestFacts> {
	if (header.pr === undefined) return { warnings: [] };
	const number = parsePrNumber(header.pr);
	if (number === undefined) return { warnings: [`the PR line "${header.pr}" is not a pull request number like #41`] };
	if (readOnly) return { warnings: [`pull request #${number} is not read: the forge is in read-only mode`] };
	try {
		const pull = await forge.getPullRequest(number);
		const pushedHead = branch === undefined ? undefined : await git.remoteRef(`origin/${branch}`);
		return {
			pr: {
				number,
				state: pull.state,
				merged: pull.merged,
				...(pull.mergedAt === undefined ? {} : { mergedAt: pull.mergedAt }),
				...(pushedHead === undefined ? {} : { pushedHead }),
			},
			warnings: [],
		};
	} catch (error) {
		if (!isOffline(error) && !(error instanceof Error)) throw error;
		return { warnings: [`pull request #${number} cannot be read: ${error.message}`] };
	}
}
