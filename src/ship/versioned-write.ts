// One versioned issue-body write with a retry over a fresh read, shared by every ship-phase body writer.

import type { Forge } from "../forge/types.ts";

const RETRIES = 1;

export type BodyWrite = { status: "written" | "unchanged"; body: string } | { status: "conflict" };

/**
 * Reads the issue, applies `edit` and writes the result with the read version. `edit` returns undefined when nothing
 * is to change. A concurrent edit gets one retry over a fresh read; then `conflict`.
 */
export async function writeBodyWithRetry(forge: Pick<Forge, "getIssue" | "updateIssueBody">, issue: number, edit: (body: string) => string | undefined): Promise<BodyWrite> {
	for (let attempt = 0; attempt <= RETRIES; attempt++) {
		const current = await forge.getIssue(issue);
		const next = edit(current.body);
		if (next === undefined) return { status: "unchanged", body: current.body };
		const written = await forge.updateIssueBody(issue, next, current.version);
		if (written.status === "written") return { status: "written", body: next };
	}
	return { status: "conflict" };
}
