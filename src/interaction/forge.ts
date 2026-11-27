// The forge adapter (design D2, D4): a request is an own marked `request`
// comment with plain text from `renderForgeRequest`; answers are plain `/livespec …`
// command comments from writers, matched purely by `matchCommands`.

import type { Forge } from "../forge/types.ts";
import type { Ledger } from "../ledger/index.ts";
import { readOwnRecords } from "../ledger/records.ts";
import type { ApprovalRequest, Approver } from "./approver.ts";
import { renderForgeRequest } from "./forge-text.ts";
import { openRequestFor, readRequests, requestComment } from "./requests.ts";

export {
	type ClassChange,
	type CommandMatch,
	type MatchOptions,
	type MatchResult,
	matchCommands,
	type Permission,
} from "./forge-match.ts";
export { commandAuthors, type Permissions, readPermissions } from "./forge-permissions.ts";

/** Thrown by `request` when a request for the same subject is already pending or applying. */
export class DuplicateRequestError extends Error {
	constructor(readonly pendingId: string, subject: string) {
		super(`A request for ${subject} is pending (${pendingId}): wait for its answer or end it with /livespec dismiss.`);
		this.name = "DuplicateRequestError";
	}
}

// --- the adapter -------------------------------------------------------------------

export type ForgeApproverOptions = {
	/** Connected, writable and not blocked by the account; defaults to "not read-only" when the forge tells. */
	available?: () => boolean;
};

function defaultAvailable(forge: Forge): () => boolean {
	const readOnly = (forge as { isReadOnly?: () => boolean }).isReadOnly;
	return () => (typeof readOnly === "function" ? !readOnly.call(forge) : true);
}

/** `ledger` holds the change's ledger records, read with the comments for the open-request check. */
export function createForgeApprover(forge: Forge, ledger: Ledger, issue: number, opts: ForgeApproverOptions = {}): Approver {
	return {
		name: "forge",
		available: opts.available ?? defaultAvailable(forge),
		async request(r) {
			// `whoami` first, so an unreachable forge fails the request instead of reading no own records.
			const { login } = await forge.whoami();
			const { records } = await readOwnRecords(forge, ledger, issue, { login });
			const open = openRequestFor(readRequests(records), r.subject);
			if (open !== undefined) throw new DuplicateRequestError(open, r.subject);
			await forge.createComment(issue, requestComment(r.record.id, r.record, renderForgeRequest(r)));
			return { status: "pending", requestId: r.record.id };
		},
	};
}
