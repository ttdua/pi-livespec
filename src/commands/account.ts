// `/livespec account [name]`: without a name, shows the forge host, the account
// in use, its source, the stored remote and every candidate with its access
// and why it was not chosen; with a name, switches the session to it through
// `Session.switchAccount`. Never throws; tokens are never read here.

import { accountLabel, blockText, candidateLines, sourceLabel, storedRemote } from "../accounts/describe.ts";
import type { Session } from "../hooks/session.ts";

const NOT_INITIALIZED = "livespec is not set up in this project: run /livespec init first.";
const NOT_CONNECTED = "No forge account is resolved in this session";
const NO_CANDIDATES = "Candidates: none listed";

/** Runs `/livespec account [name]` against the session of the command's project, if any. */
export async function runAccountCommand(args: string, session: Session | undefined): Promise<string> {
	if (!session?.initialized) return NOT_INITIALIZED;
	const name = args.trim();
	if (name !== "") return (await session.switchAccount(name)).message;
	return showAccount(session);
}

function showAccount(session: Session): string {
	const account = session.account;
	const host = session.target?.authority;
	if (!account || host === undefined) {
		const reason = session.accountBlock ?? session.forgeError;
		return reason === undefined ? `${NOT_CONNECTED}.` : `${NOT_CONNECTED}: ${reason}`;
	}
	const blocked = session.accountBlock;
	const candidates = candidateLines(account, blocked !== undefined);
	return [
		`Host: ${host}`,
		`Account: ${accountLabel(account)}`,
		`Source: ${sourceLabel(account)}`,
		`Stored remote: ${storedRemote(account)}`,
		...(account.unverified ? ["Unverified: the access check gave no answer, so the stored account is used as is"] : []),
		...(blocked === undefined ? [] : [`Blocked: ${blockText(blocked)}`]),
		...(candidates.length === 0 ? [NO_CANDIDATES] : ["Candidates:", ...candidates.map((line) => `- ${line}`)]),
	].join("\n");
}
