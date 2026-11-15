// The `forge-account` doctor check: reports the session's account resolution
// as `DoctorDeps` carries it — the account in use and its source, every
// candidate left out with the reason, a warning when unverified, an error with
// the exact `/livespec account` command when writes are blocked. It reads only
// `d.account` and `d.accountBlock`: it never calls the forge, runs no
// selection and writes no setting.

import { type DoctorCheck, type DoctorResult, registerDoctorCheck } from "../commands/doctor.ts";
import { SWITCH_COMMAND, accountLabel, blockText, leftOutLines, sourceLabel } from "./describe.ts";
import type { ResolvedAccount } from "./resolve.ts";

const ID = "forge-account";
const UNVERIFIED = "unverified: the forge could not be reached to check its write access";
const RETRY = "run /livespec doctor again once the forge is reachable";
const LOG_IN = `log in with an account that can push, then run ${SWITCH_COMMAND}`;

function summary(a: ResolvedAccount, blocked: boolean): string {
	const leftOut = leftOutLines(a, blocked);
	const head = [`account ${accountLabel(a)}`, `source ${sourceLabel(a)}`, ...(a.unverified ? [UNVERIFIED] : [])].join(", ");
	return `${head}; left out: ${leftOut.length === 0 ? "none" : leftOut.join("; ")}`;
}

/** The command that lifts the block: one of the candidates that can push, else how to get one. */
function blockSuggestion(a: ResolvedAccount | undefined): string {
	const writers = (a?.facts.candidates ?? []).filter((e) => e.access === "true").map((e) => e.candidate.name);
	return writers.length === 0 ? LOG_IN : `run ${SWITCH_COMMAND} with one of: ${writers.join(", ")}`;
}

export const checkForgeAccount: DoctorCheck = async (d) => {
	const { account, accountBlock } = d;
	if (accountBlock !== undefined) {
		return [{ id: ID, status: "error", message: blockText(accountBlock), suggestion: blockSuggestion(account) }];
	}
	if (account === undefined) return [];
	const result: DoctorResult = account.unverified
		? { id: ID, status: "warn", message: summary(account, false), suggestion: RETRY }
		: { id: ID, status: "ok", message: summary(account, false) };
	return [result];
};

registerDoctorCheck(ID, checkForgeAccount);
