// Shared, deterministic descriptions of a resolved account for the
// `/livespec account` command and the `forge-account` doctor check: who is in
// use, from which source, and why every other candidate was left out. Text the
// forge reported (the `whoami` login of an environment token, block reasons)
// is wrapped as untrusted; tokens are never read here.

import { untrusted } from "../hooks/phase-card.ts";
import type { ResolvedAccount } from "./resolve.ts";
import { SOURCE_LABEL, type SelectionFacts } from "./types.ts";

/** The command that lifts a block or changes the account. */
export const SWITCH_COMMAND = "/livespec account <name>";
const NONE = "none";
const ENV_TOKEN = "the environment token";

type CandidateEntry = SelectionFacts["candidates"][number];

/** The account in use: its name, or for an environment token the forge login (untrusted); `none` when refused. */
export function accountLabel(a: ResolvedAccount): string {
	if (a.account !== undefined) return a.account;
	if (a.source === "env") return a.user === undefined ? ENV_TOKEN : untrusted(a.user);
	return NONE;
}

/** The human label of the source; `none` when the resolution refused. */
export function sourceLabel(a: ResolvedAccount): string {
	return a.source === undefined ? NONE : SOURCE_LABEL[a.source];
}

/** The remote the stored account belongs to: the one just written for a new choice, else the one read; `none` when unset. */
export function storedRemote(a: ResolvedAccount): string {
	if (a.source === "auto" || a.source === "asked") return a.facts.remote;
	return a.facts.stored?.remote ?? NONE;
}

/** Why `entry` is or is not the account in use. */
function reasonOf(a: ResolvedAccount, entry: CandidateEntry, blocked: boolean): string {
	if (entry.candidate.name === a.account) return "in use";
	if (entry.access === "false") return "cannot push";
	if (entry.access === "unknown") return a.source === "stored" && !a.unverified ? "not checked: the stored account can push" : "the check gave no answer";
	return blocked ? "can push, not chosen: writes are refused until one is chosen" : "can push, another account is in use";
}

function candidateLine(a: ResolvedAccount, entry: CandidateEntry, blocked: boolean): string {
	const { name, user } = entry.candidate;
	return `${name} (${user}): access ${entry.access}, ${reasonOf(a, entry, blocked)}`;
}

/** One line per candidate with its access and the reason it was or was not chosen. */
export function candidateLines(a: ResolvedAccount, blocked: boolean): string[] {
	return a.facts.candidates.map((entry) => candidateLine(a, entry, blocked));
}

/** The candidates other than the one in use, each with its reason. */
export function leftOutLines(a: ResolvedAccount, blocked: boolean): string[] {
	return a.facts.candidates.filter((e) => e.candidate.name !== a.account).map((entry) => candidateLine(a, entry, blocked));
}

/** The block reason as its producer built it: forge-derived fragments are already wrapped as untrusted. */
export function blockText(block: string): string {
	return `writes are refused: ${block}`;
}

/** `text`, followed by `hint` only when `text` does not already name the switch command, so the guidance appears once. */
export function withSwitchHint(text: string, hint: string): string {
	return text.includes(SWITCH_COMMAND) ? text : `${text} ${hint}`;
}
