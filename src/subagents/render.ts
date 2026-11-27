// Renders the layers of a packet: protocol, flow block, task and footer.

import { PROHIBITIONS, protocolText } from "./protocol.ts";
import { rubricFor } from "./rubrics.ts";
import { untrusted } from "../hooks/phase-card.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { PacketSource, Target } from "./source-types.ts";
import type { ReviewSubject } from "./roles.ts";

export const TASK_HEADING = "## Task";
export const FOOTER_HEADING = "## Footer";

export type Flow = { pack: Pack; tree: string | undefined; skills: string[] };

/** Layers 1 and 2: identical across units of one change and role, nothing time-varying. */
export function renderPrefix(flow: Flow): string {
	const tree = flow.tree === undefined ? "none" : (flow.tree.split("/").filter(Boolean).at(-1) ?? "none");
	const lines = ["## Flow", `Pack: ${flow.pack.name} (version ${flow.pack.version})`, `Content tree: ${tree}`, `Flow skills: ${flow.skills.length === 0 ? "none" : flow.skills.join(", ")}`];
	return `${protocolText()}\n${lines.join("\n")}\n\n`;
}

const sourceLine = (s: { id: string; version: string }): string => `${s.id} ${s.version}`;

export function renderSource(s: PacketSource): string {
	const optional = s.required ? "" : "optional: list in sources_used only if you used it\n";
	return `### ${s.id} — ${s.title}\nversion: ${s.version}\n${optional}${s.untrusted ? untrusted(s.text) : s.text}\n`;
}

export type Spilled = { source: PacketSource; path: string };

/** Layer 3: the task. `inline` and `spilled` partition the sources in manifest order. */
export function renderTask(t: { target: Target; unitText: string | undefined; notes?: string[]; inline: PacketSource[]; spilled: Spilled[]; verify?: string; files: string[] }): string {
	const { target } = t;
	const head = [TASK_HEADING, `Role: ${target.role}`];
	if (target.unit) head.push(`Unit: ${target.unit.id}`);
	if (target.subject) head.push(`Subject: ${target.subject}`, `Rubric: ${rubricFor(target.subject as ReviewSubject)}`);
	const parts = [head.join("\n"), t.unitText === undefined ? "" : `### Unit\n${t.unitText}\n`, "### Sources", ...t.inline.map(renderSource)];
	if (t.notes?.length) parts.push("### Search scope", ...t.notes);
	parts.push("### Spilled sources", t.spilled.length === 0 ? "none" : t.spilled.map((s) => `- ${s.source.id} ${s.source.version} ${s.path}${s.source.required ? "" : " (optional)"}`).join("\n"));
	if (t.verify !== undefined) parts.push(`### Verify\n${t.verify}`);
	parts.push(`### Files\n${t.files.length === 0 ? "none" : t.files.join("\n")}`, `### Prohibitions\n${PROHIBITIONS.map((p) => `- ${p}`).join("\n")}`);
	return `${parts.join("\n")}\n`;
}

/** Layer 4. */
export function renderFooter(hash: string, sources: { id: string; version: string }[]): string {
	return `${FOOTER_HEADING}\nPacket hash: ${hash}\n${sources.map(sourceLine).join("\n")}\n`;
}

export const tokensOf = (text: string): number => Math.ceil(text.length / 4);
