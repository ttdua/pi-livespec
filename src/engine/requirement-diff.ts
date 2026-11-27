// Requirement digests shared by change_sync and the spec-diff cascade (design D1): one id per requirement,
// one sha256 per requirement content, compared as maps so a baseline record and git agree on the shape.

import { createHash } from "node:crypto";
import { type Change, declaredCapabilities } from "../core/change.ts";
import { parseSpec, type Requirement } from "../core/spec.ts";
import type { Git } from "./git.ts";

/** Digest recorded for an id absent at HEAD. */
export const REMOVED_DIGEST = "removed";

/** Separates the capability from the requirement name in a `Covers` entry and in a requirement id. */
export const COVERS_SEPARATOR = "/Requirement:";

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The whole requirement block, body text and scenarios, with every whitespace run collapsed, so re-wrapped or
 * re-indented text is not a change. Line positions are not part of it: `parseSpec` already drops them.
 */
export function requirementContent(r: Requirement): string {
	const scenarios = r.scenarios.map(({ name, given, when, then }) => ({
		name: collapse(name),
		given: given.map(collapse),
		when: when.map(collapse),
		then: then.map(collapse),
	}));
	return JSON.stringify({ text: collapse(r.text), scenarios });
}

/** `<capability>/Requirement: <name>` to sha256 of its content, for every requirement at `rev`; a missing file contributes nothing. */
export async function requirementDigests(git: Git, rev: string, capabilities: string[]): Promise<Record<string, string>> {
	const perCapability = await Promise.all(
		capabilities.map(async (capability) => {
			const text = await git.showFile(rev, `specs/${capability}/spec.md`);
			if (text === undefined) return [];
			return parseSpec(text, capability).requirements.map((r) => {
				const digest = createHash("sha256").update(requirementContent(r)).digest("hex");
				return [`${capability}${COVERS_SEPARATOR} ${r.name}`, digest] as const;
			});
		}),
	);
	return Object.fromEntries(perCapability.flat());
}

/** Ids whose digest differs between the maps, including ids on one side only; sorted. */
export function changedIds(before: Record<string, string>, after: Record<string, string>): string[] {
	const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...ids].filter((id) => before[id] !== after[id]).sort();
}

/** Trims an entry and collapses its inner whitespace runs, so `Covers` entries match requirement ids. */
export const coversId = (entry: string): string => collapse(entry);

/** The capability of a `Covers` entry (the text before `COVERS_SEPARATOR`), or undefined when empty. */
export function capabilityOf(covers: string): string | undefined {
	const capability = (coversId(covers).split(COVERS_SEPARATOR)[0] ?? "").trim();
	return capability === "" ? undefined : capability;
}

/** The capabilities whose living specs the change touches: declared, plus those its units cover; sorted, unique. */
export function requirementScope(change: Change): string[] {
	const covered = change.units.flatMap((u) => u.covers.map(capabilityOf)).filter((c): c is string => c !== undefined);
	return [...new Set([...declaredCapabilities(change), ...covered])].sort();
}
