// The reviewer's view of the behavior items (durable-doc-checks "Behavior conclusions in the reviewer packet"): one
// required source listing each item with its files and effective conclusion, for the `reviewer`/`change` target only.

import { neutralise } from "../interaction/briefing.ts";
import { sha256 } from "../subagents/source-kit.ts";
import type { PacketSource, SourceProvider } from "../subagents/source-types.ts";
import { type BehaviorConclusion, type BehaviorItem, effectiveConclusion } from "./behavior-change.ts";
import { changeBehaviorItems } from "./behavior-check.ts";

export const BEHAVIOR_SOURCE_ID = "records:behavior-conclusions";

function lineOf(item: BehaviorItem, conclusion: BehaviorConclusion | undefined): string {
	const files = item.files.join(", ");
	if (conclusion === undefined) return `- ${item.capability}: none; files: ${files}`;
	return `- ${item.capability}: ${conclusion.outcome} (${conclusion.source}) — ${neutralise(conclusion.reason)}; files: ${files}`;
}

/** The required source `records:behavior-conclusions`; left out when the change has no behavior item. */
export const behaviorSourceProvider: SourceProvider = async (ctx, target) => {
	if (target?.role !== "reviewer" || target.subject !== "change") return [];
	const items = await changeBehaviorItems(ctx.root, ctx.git, ctx.state.change.header.base);
	if (items.length === 0) return [];
	const text = items.map((item) => lineOf(item, effectiveConclusion(ctx.state.marked, item))).join("\n");
	const source: PacketSource = { id: BEHAVIOR_SOURCE_ID, version: sha256(text), title: "Behavior conclusions", text, untrusted: true, required: true };
	return [source];
};
