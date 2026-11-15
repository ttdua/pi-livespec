// The `forge-account` card section: one line while writes are blocked by the
// account (on every card), or the one-time notice of an automatic or asked
// choice (on the first model card only, which `Session.firstCardShown`
// enforces), and nothing otherwise. It reads only `i.account` and is pure.

import { type CardSection, registerCardSection } from "../hooks/phase-card.ts";
import { SWITCH_COMMAND, blockText, withSwitchHint } from "./describe.ts";

const PREFIX = "Account: ";
const HINT = `See /livespec account, or switch with ${SWITCH_COMMAND}.`;

export const accountSection: CardSection = (i) => {
	const account = i.account;
	if (account?.blocked !== undefined) return `${PREFIX}${withSwitchHint(blockText(account.blocked), HINT)}`;
	if (account?.line !== undefined) return `${PREFIX}${account.line}`;
	return undefined;
};

registerCardSection("forge-account", accountSection);
