// `/livespec skills <status|update|pin <sha>|unpin|rollback>`: routes to the
// agent-skills `ContentManager` and turns its outcome into text.

import type { Channel } from "../config.ts";
import type { ContentManager, UpgradeOutcome } from "../content/manager.ts";
import type { WorkInProgress } from "../content/wip.ts";
import type { LoadedPack, Pack } from "../engine/pack-types.ts";
import { formatPackError, messageOf } from "./messages.ts";

export type SkillsCommandDeps = { content: ContentManager; pack: LoadedPack; channel: Channel; wip: () => Promise<WorkInProgress> };

export const SKILLS_USAGE = "Usage: /livespec skills <status|update|pin <sha>|unpin|rollback>";
const UNPINNED = "agent-skills is no longer pinned";

export async function runSkillsCommand(args: string, d: SkillsCommandDeps): Promise<string> {
	const [sub, ...rest] = args.trim().split(/\s+/);
	if (sub === "status" && rest.length === 0) return d.content.status(d.channel);
	if (sub === "unpin" && rest.length === 0) return unpin(d.content);
	if (sub === "rollback" && rest.length === 0) return formatOutcome(await d.content.rollback());
	if (sub === "update" && rest.length === 0) return withPack(d, async (pack) => d.content.update(pack, await d.wip()));
	const sha = rest[0];
	if (sub === "pin" && sha !== undefined && rest.length === 1) return withPack(d, async (pack) => d.content.pin(sha, pack, await d.wip()));
	return SKILLS_USAGE;
}

/** `unpin` returns nothing and throws when the root lock stays busy; the error is the message. */
async function unpin(content: ContentManager): Promise<string> {
	try {
		await content.unpin();
		return UNPINNED;
	} catch (e) {
		return `agent-skills unpin failed: ${messageOf(e)}`;
	}
}

/** Installing needs a valid pack for the compatibility check. */
async function withPack(d: SkillsCommandDeps, run: (pack: Pack) => Promise<UpgradeOutcome>): Promise<string> {
	if (!d.pack.ok) return `agent-skills refused: the flow pack is invalid\n${d.pack.errors.map((e) => `- ${formatPackError(e)}`).join("\n")}`;
	return formatOutcome(await run(d.pack.pack));
}

export function formatOutcome(o: UpgradeOutcome): string {
	switch (o.kind) {
		case "installed": {
			const { added, removed, changed } = o.changed;
			const lines = [`agent-skills installed ${o.sha}`];
			if (added.length > 0) lines.push(`added: ${added.join(", ")}`);
			if (removed.length > 0) lines.push(`removed: ${removed.join(", ")}`);
			if (changed.length > 0) lines.push(`changed: ${changed.join(", ")}`);
			return lines.join("\n");
		}
		case "notified":
			return `agent-skills ${o.sha} is available; run /livespec skills update`;
		default: {
			const items = o.failures?.map((f) => `- ${f.item}: ${f.reason}`) ?? [];
			return [`agent-skills ${o.kind}: ${o.reason}`, ...items].join("\n");
		}
	}
}
