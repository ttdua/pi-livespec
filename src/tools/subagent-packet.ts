// `subagent_packet <role> [unit] [subject]`: the packet a dispatch would build, for running the role inline.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildPacket, changeName } from "../subagents/packet.ts";
import { writePacket } from "../subagents/packet-store.ts";
import { requireChange, requireSession, requireValidPack, requireWritable, type ToolResult, toolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { findingOf, packetContext, packetText } from "./subagent-request.ts";
import { argsOf, checkTarget, childRefusal, refusal, TARGET_PROPERTIES, type TargetParams, type ToolCtx } from "./subagent-target.ts";

const TOOL = "subagent_packet";

export async function runSubagentPacket(p: TargetParams, ctx: ToolCtx): Promise<ToolResult<undefined>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return child;
	const s = requireSession();
	if (!s.ok) return refusal(TOOL, s.message);
	const pack = requireValidPack(s.session);
	if (!pack.ok) return refusal(TOOL, pack.message);
	await s.session.refresh();
	const writable = requireWritable(s.session);
	if (!writable.ok) return refusal(TOOL, writable.message);
	const change = requireChange(s.session);
	if (!change.ok) return refusal(TOOL, change.message);
	const target = checkTarget(p, change.state);
	if (typeof target === "string") return refusal(TOOL, target);
	const found = findingOf(change.state, target);
	if (typeof found === "string") return refusal(TOOL, found);
	const pctx = packetContext({ session: s.session, pack: pack.pack, forge: writable.forge }, change.state, target.unit, found);
	const built = await buildPacket(pctx, target.role, target.unit, target.subject);
	if (!built.ok) return refusal(TOOL, built.message);
	await writePacket(pctx.root, changeName(pctx), built.packet);
	return toolResult(`Run ${argsOf(target)} inline with this packet, then record the result with subagent_record ${argsOf(target)}.\n\n${packetText(built.packet)}`, undefined);
}

export function registerSubagentPacket(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Build a livespec subagent packet",
		description: "Return the packet subagent_dispatch would build for a role (and unit or subject), without launching, so the role can run inline; finish with subagent_record.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: { type: "object", properties: TARGET_PROPERTIES, required: ["role"] } as never,
		execute: (_id, params, _signal, _update, ctx) => runSubagentPacket(params as TargetParams, ctx as never),
	});
}
