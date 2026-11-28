// The one reader seam of own records (design D3b): the current account's marked comments of a
// change merged with the entries of its ledger.

import { isOffline } from "../forge/errors.ts";
import { filterMarked, type MarkedComment } from "../forge/markers.ts";
import type { Comment, Forge } from "../forge/types.ts";
import type { FetchState, Ledger } from "./index.ts";
import { mergeRecords } from "./merge.ts";

/** `stale`: the current login is unknown (forge unreachable), so no own comment was read. */
export type OwnRecords = { records: MarkedComment[]; warnings: string[]; stale: boolean };

export const UNKNOWN_LOGIN_WARNING = "the forge is unreachable and the current login is unknown: own marked comments are not read";

/**
 * Own marked comments of change `n` (filtered from `o.comments` when given, else listed) merged with
 * its ledger entries, read from the local ref only. `o.login` skips the `whoami` call. Ledger read
 * problems and a pending sync become warnings.
 */
export async function readOwnRecords(forge: Forge, ledger: Ledger, n: number, o: { comments?: Comment[]; login?: string } = {}): Promise<OwnRecords> {
	const [own, read, pending] = await Promise.all([ownComments(forge, n, o), ledger.read(n), ledger.pending(n)]);
	return {
		records: mergeRecords(own.comments, read.entries),
		warnings: [...own.warnings, ...read.warnings, ...(pending ? [pendingWarning(n)] : [])],
		stale: own.stale,
	};
}

/** The warning of a first ledger fetch that failed; none after a successful one. */
export function fetchWarnings(state: FetchState, n: number): string[] {
	if (state === "stale-known") return [`the ledger of #${n} could not be fetched from origin, so its records may be out of date`];
	if (state === "unknown-offline") return [`the ledger of #${n} could not be fetched and no copy of it is known, so its records read as empty; writes are refused until it is fetched`];
	return [];
}

const pendingWarning = (n: number): string => `the ledger of #${n} has entries not on origin yet; the next sync pushes them`;

async function ownComments(forge: Forge, n: number, o: { comments?: Comment[]; login?: string }): Promise<{ comments: MarkedComment[]; warnings: string[]; stale: boolean }> {
	const login = o.login ?? (await currentLogin(forge));
	if (login === undefined) return { comments: [], warnings: [UNKNOWN_LOGIN_WARNING], stale: true };
	const comments = o.comments ?? (await forge.listComments(n));
	return { ...filterMarked(comments, login), stale: false };
}

/**
 * The login confirmed by `whoami` now, or undefined when the forge is unreachable. A login seen
 * earlier is never reused: the account may have switched, and its state must not be counted.
 */
async function currentLogin(forge: Forge): Promise<string | undefined> {
	try {
		return (await forge.whoami()).login;
	} catch (error) {
		if (isOffline(error)) return undefined;
		throw error;
	}
}
