// The reviewer's view of the behavior items (durable-doc-checks "Behavior conclusions in the reviewer packet"):
// items and effective conclusions are computed once; the packet source text and `Packet.behavior` both use them.

import { neutralise } from "../interaction/briefing.ts";
import { sha256 } from "../subagents/source-kit.ts";
import type { Packet, PacketContext, PacketSource, SourceProvider } from "../subagents/source-types.ts";
import { type BehaviorConclusion, type BehaviorItem, effectiveConclusion } from "./behavior-change.ts";
import { changeBehaviorItems } from "./behavior-check.ts";

export const BEHAVIOR_SOURCE_ID = "records:behavior-conclusions";

const computed = new WeakMap<PacketContext, Promise<Packet["behavior"]>>();

/** The items of the change and their effective conclusions; undefined when there is no item. One packet build reads them once. */
export function behaviorPacketData(ctx: PacketContext): Promise<Packet["behavior"]> {
	const known = computed.get(ctx);
	if (known !== undefined) return known;
	const fresh = compute(ctx);
	computed.set(ctx, fresh);
	return fresh;
}

async function compute(ctx: PacketContext): Promise<Packet["behavior"]> {
	const items: BehaviorItem[] = await changeBehaviorItems(ctx.root, ctx.git, ctx.state.change.header.base);
	if (items.length === 0) return undefined;
	const effective: Record<string, BehaviorConclusion | null> = {};
	for (const item of items) effective[item.capability] = effectiveConclusion(ctx.state.marked, item) ?? null;
	return { items, effective };
}

function lineOf(item: BehaviorItem, conclusion: BehaviorConclusion | null | undefined): string {
	const files = item.files.join(", ");
	if (conclusion === null || conclusion === undefined) return `- ${item.capability}: none; files: ${files}`;
	return `- ${item.capability}: ${conclusion.outcome} (${conclusion.source}) — ${neutralise(conclusion.reason)}; files: ${files}`;
}

/** The required source `records:behavior-conclusions`, for the `reviewer`/`change` target only. */
export const behaviorSourceProvider: SourceProvider = async (ctx, target) => {
	if (target?.role !== "reviewer" || target.subject !== "change") return [];
	const data = await behaviorPacketData(ctx);
	if (data === undefined) return [];
	const text = data.items.map((item) => lineOf(item, data.effective[item.capability])).join("\n");
	const source: PacketSource = { id: BEHAVIOR_SOURCE_ID, version: sha256(text), title: "Behavior conclusions", text, untrusted: true, required: true };
	return [source];
};
