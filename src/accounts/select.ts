// Pure account selection: what to use for this clone, from the facts alone.
// Each rule is one function; the first that returns a result wins, as in
// `nextStep`. The active `gh` account and the `tea` default flag are not facts.

import { isSafeAccountName } from "./store.ts";
import type { Access, AccountCandidate, SelectionFacts, SelectionResult } from "./types.ts";

type Entry = SelectionFacts["candidates"][number];

/** What the rules see: the facts and the values derived from them once. */
type RuleInput = {
	facts: SelectionFacts;
	/** The stored candidate when it is valid for the forge, matches the remote and is still a candidate. */
	stored: Entry | undefined;
	writers: Entry[];
};

type Rule = (i: RuleInput) => SelectionResult | undefined;

const names = (entries: Entry[]): string[] => entries.map((e) => e.candidate.name);
const hasAccess = (e: Entry | undefined, access: Access): boolean => e?.access === access;

function derive(facts: SelectionFacts): RuleInput {
	const { stored, forge, remote, candidates } = facts;
	// A stored name invalid for the forge counts as not stored.
	const matches = stored !== undefined && isSafeAccountName(stored.account, forge) && stored.remote === remote;
	const entry = matches ? candidates.find((e) => e.candidate.name === stored.account) : undefined;
	return { facts, stored: entry, writers: candidates.filter((e) => e.access === "true") };
}

const environmentToken: Rule = ({ facts }) => (facts.envToken ? { kind: "env" } : undefined);

const storedCanWrite: Rule = ({ stored }) =>
	stored && hasAccess(stored, "true") ? { kind: "use", account: stored.candidate.name, source: "stored", unverified: false } : undefined;

const singleWriter: Rule = ({ writers }) =>
	writers.length === 1 ? { kind: "store", account: writers[0].candidate.name, source: "auto" } : undefined;

const severalWriters: Rule = ({ facts, writers }) => {
	if (writers.length < 2) return undefined;
	const options = names(writers);
	return facts.hasUI ? { kind: "ask", options } : { kind: "refuse", reason: "ambiguous", options };
};

const storedUnverified: Rule = ({ stored }) =>
	stored && hasAccess(stored, "unknown") ? { kind: "use", account: stored.candidate.name, source: "stored", unverified: true } : undefined;

const refusal: Rule = ({ facts }) => {
	const options = names(facts.candidates);
	return { kind: "refuse", reason: options.length === 0 ? "no-candidates" : "no-access", options };
};

const RULES: readonly Rule[] = [environmentToken, storedCanWrite, singleWriter, severalWriters, storedUnverified, refusal];

/** The selection for these facts. Pure: equal facts give equal results. */
export function selectAccount(facts: SelectionFacts): SelectionResult {
	const input = derive(facts);
	for (const rule of RULES) {
		const result = rule(input);
		if (result) return result;
	}
	throw new Error("unreachable: the last selection rule always decides");
}
