import { createHash } from "node:crypto";
import type { IssueState, Version } from "./types.ts";

/** Prefix of a re-read version: `gh` for GitHub, `rc` for Gitea without content_version. */
export type ReadVersionPrefix = "gh" | "rc";

/** The fields a body write compares. Field names match the `changedFields` output. */
export interface ComparableIssue {
	title: string;
	body: string;
	labels: string[];
	state: IssueState;
}

const COMPARED_FIELDS = ["title", "body", "labels", "state"] as const;

/**
 * Builds `<prefix>:<updatedAt>:<sha256(body)>`. The hash is of the body only,
 * so a title-only edit changes `updatedAt` but not the body hash.
 */
export function bodyVersion(updatedAt: string, body: string, prefix: ReadVersionPrefix = "gh"): Version {
	const digest = createHash("sha256").update(body, "utf8").digest("hex");
	return `${prefix}:${updatedAt}:${digest}` as Version;
}

/** Lists the compared fields that differ between `a` and `b`, in a fixed order. Labels compare as sets. */
export function changedFields(a: ComparableIssue, b: ComparableIssue): string[] {
	return COMPARED_FIELDS.filter((field) => !fieldEquals(a, b, field));
}

function fieldEquals(a: ComparableIssue, b: ComparableIssue, field: (typeof COMPARED_FIELDS)[number]): boolean {
	if (field === "labels") return sameLabels(a.labels, b.labels);
	return a[field] === b[field];
}

function sameLabels(a: string[], b: string[]): boolean {
	const left = [...new Set(a)].sort();
	const right = [...new Set(b)].sort();
	return left.length === right.length && left.every((label, i) => label === right[i]);
}
