// The approver chain for one tool call (design D6): the configured adapter
// list, the in-session adapter over the tool `ctx` UI, and the forge adapter
// when the session's forge is connected, writable and not blocked.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { adapterChain } from "../config.ts";
import type { Session } from "../hooks/session.ts";
import type { AdapterName, Approver, ApproverUI } from "../interaction/approver.ts";
import { createForgeApprover } from "../interaction/forge.ts";
import type { DialogFactory } from "../interaction/dialog/types.ts";
import { createInSessionApprover } from "../interaction/in-session.ts";

/** pi does not re-export `ExtensionMode` from its root. */
type ExtensionMode = ExtensionContext["mode"];

/** What a waiting custom dialog reports, so terminals with program status show pi as blocked. */
type CustomOptions = { blocked: { kind: "question"; message: string } };

/** The tool `ctx` subset: `hasUI`, `mode` and the dialog methods of `ctx.ui`. */
export type ApproverCtx = {
	hasUI: boolean;
	mode?: ExtensionMode;
	ui: Omit<ApproverUI, "hasUI" | "dialog"> & { custom?: <T>(factory: DialogFactory<T>, options?: CustomOptions) => Promise<T | undefined> };
};

const BLOCKED: CustomOptions = { blocked: { kind: "question", message: "livespec is waiting for your answer" } };

export type ApproverChain = { chain: AdapterName[]; adapters: Partial<Record<AdapterName, Approver>> };

/** Whether the session's forge can take requests: connected, writable and not blocked by the account. */
export function forgeWritable(session: Session): boolean {
	return session.forge !== undefined && !session.forge.isReadOnly() && session.accountBlock === undefined;
}

/** The in-session UI over `ctx`; `dialog` only where pi draws custom components (`mode` `tui`, design D2). */
export function uiOf(ctx: ApproverCtx): ApproverUI {
	const ui: ApproverUI = {
		hasUI: ctx.hasUI,
		select: (title, options) => ctx.ui.select(title, options),
		input: (title, placeholder) => ctx.ui.input(title, placeholder),
	};
	if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
		const custom = ctx.ui.custom.bind(ctx.ui);
		ui.dialog = (factory) => custom(factory, BLOCKED);
	}
	return ui;
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
