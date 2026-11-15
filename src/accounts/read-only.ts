// The login a refused Gitea selection still reads with. Writes stay blocked by
// the session's account block; this only keeps the adapter from failing on
// several `tea` logins for one host, so reads keep working.

import type { SelectionFacts } from "./types.ts";

/**
 * The stored account when it is still a candidate, else the first candidate the forge did not deny
 * (candidate order); `undefined` when none qualifies. Pure.
 */
export function readOnlyLogin(facts: SelectionFacts): string | undefined {
	const stored = facts.stored?.account;
	if (stored !== undefined && facts.candidates.some((e) => e.candidate.name === stored)) return stored;
	return facts.candidates.find((e) => e.access !== "false")?.candidate.name;
}
