// The approver chain for one tool call (design D6): the configured adapter
// list, the in-session adapter over the tool `ctx` UI, and the forge adapter
// when the session's forge is connected, writable and not blocked.

import { adapterChain } from "../config.ts";
import type { Session } from "../hooks/session.ts";
import type { AdapterName, Approver, ApproverUI } from "../interaction/approver.ts";
import { createForgeApprover } from "../interaction/forge.ts";
import { createInSessionApprover } from "../interaction/in-session.ts";

/** The tool `ctx` subset: `hasUI` plus the dialog methods of `ctx.ui`. */
export type ApproverCtx = { hasUI: boolean; ui: Omit<ApproverUI, "hasUI"> };

export type ApproverChain = { chain: AdapterName[]; adapters: Partial<Record<AdapterName, Approver>> };

/** Whether the session's forge can take requests: connected, writable and not blocked by the account. */
export function forgeWritable(session: Session): boolean {
	return session.forge !== undefined && !session.forge.isReadOnly() && session.accountBlock === undefined;
}

function uiOf(ctx: ApproverCtx): ApproverUI {
	return {
		hasUI: ctx.hasUI,
		select: (title, options) => ctx.ui.select(title, options),
		input: (title, placeholder) => ctx.ui.input(title, placeholder),
	};
}

/** The forge login recorded as `by` for in-session answers; `unknown` when the forge cannot say. */
async function loginOf(session: Session): Promise<string> {
	try {
		return session.forge ? (await session.forge.whoami()).login : "unknown";
	} catch {
		return "unknown";
	}
}

export function approverFor(session: Session, ctx: ApproverCtx, issue: number): ApproverChain {
	const { chain } = adapterChain(session.config);
	const adapters: Partial<Record<AdapterName, Approver>> = {
		"in-session": createInSessionApprover(uiOf(ctx), () => loginOf(session)),
	};
	const forge = session.forge;
	if (forge) adapters.forge = createForgeApprover(forge, issue, { available: () => forgeWritable(session) });
	return { chain, adapters };
}
