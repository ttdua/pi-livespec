// The `forge-account` doctor check: reports the session's account resolution
// as `DoctorDeps` carries it — the account in use and its source, every
// candidate left out with the reason, a warning when unverified, an error with
// the exact `/livespec account` command when writes are blocked. It reads only
// `d.account` and `d.accountBlock`: it never calls the forge, runs no
// selection and writes no setting. The block is rendered as its producer built
// it (forge-derived fragments already wrapped as untrusted).

import { type DoctorCheck, type DoctorResult, registerDoctorCheck } from "../commands/doctor.ts";
import { SWITCH_COMMAND, accountLabel, blockText, leftOutLines, sourceLabel } from "./describe.ts";
import type { ResolvedAccount } from "./resolve.ts";

const ID = "forge-account";
const UNVERIFIED = "unverified: the forge could not be reached to check its write access";
const RETRY = "run /livespec doctor again once the forge is reachable";
const LOG_IN = "log in with an account that can push";
const NO_RESOLUTION = "account none, source none; left out: none";

function summary(a: ResolvedAccount, blocked: boolean): string {
	const leftOut = leftOutLines(a, blocked);
	const head = [`account ${accountLabel(a)}`, `source ${sourceLabel(a)}`, ...(a.unverified ? [UNVERIFIED] : [])].join(", ");
	return `${head}; left out: ${leftOut.length === 0 ? "none" : leftOut.join("; ")}`;
}

/**
 * How to lift the block: the exact command for each candidate that can push; otherwise how to get one,
 * naming the switch command only when the block does not already, so it appears once.
 */
function blockSuggestion(a: ResolvedAccount | undefined, block: string): string {
	const writers = (a?.facts.candidates ?? []).filter((e) => e.access === "true").map((e) => `/livespec account ${e.candidate.name}`);
	if (writers.length > 0) return `run one of: ${writers.join(", ")}`;
	return block.includes(SWITCH_COMMAND) ? LOG_IN : `${LOG_IN}, then run ${SWITCH_COMMAND}`;
}

function blockedResult(a: ResolvedAccount | undefined, block: string): DoctorResult {
	const head = a === undefined ? NO_RESOLUTION : summary(a, true);
	return { id: ID, status: "error", message: `${head}; ${blockText(block)}`, suggestion: blockSuggestion(a, block) };
}

export const checkForgeAccount: DoctorCheck = async (d) => {
	const { account, accountBlock } = d;
	if (accountBlock !== undefined) return [blockedResult(account, accountBlock)];
	if (account === undefined) return [];
	const result: DoctorResult = account.unverified
		? { id: ID, status: "warn", message: summary(account, false), suggestion: RETRY }
		: { id: ID, status: "ok", message: summary(account, false) };
	return [result];
};

registerDoctorCheck(ID, checkForgeAccount);
