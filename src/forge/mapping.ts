// Pure mapping from forge vocabulary to the public types, shared by both
// adapters. Each table is the union of the GitHub and Gitea spellings; the
// two vocabularies do not overlap in meaning.

import type { Check, CheckState, ReviewState } from "./types.ts";

export type Permission = "none" | "read" | "write" | "admin";

/** A commit status (`success`, `failure`, `error`, `pending`, ...) as a check state; anything unknown is still pending. */
export function toCheckState(status: unknown): Exclude<CheckState, "none"> {
	if (status === "success") return "success";
	if (status === "failure" || status === "error") return "failure";
	return "pending";
}

/** Failure beats pending beats success; no checks at all is `none`. */
export function overallState(checks: Check[]): CheckState {
	if (checks.length === 0) return "none";
	if (checks.some((c) => c.state === "failure")) return "failure";
	if (checks.some((c) => c.state === "pending")) return "pending";
	return "success";
}

/** GitHub says `CHANGES_REQUESTED`, Gitea `REQUEST_CHANGES`; every other state is a comment. */
export function toReviewState(state: unknown): ReviewState {
	if (state === "APPROVED") return "approved";
	if (state === "CHANGES_REQUESTED" || state === "REQUEST_CHANGES") return "changes_requested";
	return "commented";
}

/** GitHub levels (`maintain`, `triage`) and Gitea's `owner` folded into four levels; unknown is `none`. */
export function toPermission(level: unknown): Permission {
	switch (level) {
		case "owner":
		case "admin":
			return "admin";
		case "maintain":
		case "write":
			return "write";
		case "triage":
		case "read":
			return "read";
		default:
			return "none";
	}
}
