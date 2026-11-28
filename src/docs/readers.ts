// Packet readers for the durable docs: glossary entries and decisions relevant to the packet's target.

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseDecision } from "../core/decision.ts";
import { parseGlossary } from "../core/glossary.ts";
import { joinLines } from "../core/lines.ts";
import { declaredCapabilities, readText, sectionText, sha256 } from "../subagents/source-kit.ts";
import { registerPacketBehavior, registerPacketSourceOnce } from "../subagents/sources.ts";
import type { PacketContext, PacketSource, SourceProvider, Target } from "../subagents/source-types.ts";

import { behaviorPacketData, behaviorSourceProvider } from "./behavior-source.ts";

const GLOSSARY_PATH = "specs/glossary.md";
const DECISIONS_DIR = "specs/decisions";

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive, on word boundaries where `-` is a word character. */
const mentions = (text: string, term: string): boolean => new RegExp(`(?<![\\w-])${escapeRegExp(term)}(?![\\w-])`, "i").test(text);

/** The unit's block for a unit-scoped target, the `## Units` section otherwise. */
function scopeText(ctx: PacketContext, target: Target | undefined): string {
	const unit = target?.unit;
	return unit === undefined ? sectionText(ctx.state.change, "Units") : joinLines(ctx.state.change.lines.slice(unit.startLine, unit.endLine + 1));
}

export const glossaryReader: SourceProvider = async (ctx, target) => {
	const raw = await readText(ctx.root, GLOSSARY_PATH);
	if (raw === undefined) return [];
	const scope = scopeText(ctx, target);
	const hits = parseGlossary(raw).entries.filter((e) => e.term !== "" && mentions(scope, e.term));
	if (hits.length === 0) return [];
	const text = hits.map((e) => `- **${e.term}**: ${e.definition}`).join("\n");
	return [{ id: `file:${GLOSSARY_PATH}`, version: sha256(text), title: "Glossary (entries for this unit)", text, untrusted: false, required: true }];
};

async function decisionFiles(root: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(join(root, DECISIONS_DIR), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name).sort();
}

export const decisionReader: SourceProvider = async (ctx) => {
	const declared = new Set(declaredCapabilities(ctx.state.change));
	const out: PacketSource[] = [];
	for (const name of await decisionFiles(ctx.root)) {
		const path = `${DECISIONS_DIR}/${name}`;
		const text = await readText(ctx.root, path);
		if (text === undefined) continue;
		const decision = parseDecision(name, text);
		if (decision.status !== "accepted" || decision.statusRaw === "superseded") continue;
		if (!decision.spine && !decision.capabilities.some((c) => declared.has(c))) continue;
		out.push({ id: `file:${path}`, version: sha256(text), title: `Decision ${name}`, text, untrusted: false, required: true });
	}
	return out;
};

/** Safe to call twice: `registerPacketSourceOnce` skips a provider the role already holds. */
export function registerDocReaders(): void {
	for (const role of ["implementer", "reviewer"] as const) {
		registerPacketSourceOnce(role, glossaryReader);
		registerPacketSourceOnce(role, decisionReader);
	}
	registerPacketSourceOnce("reviewer", behaviorSourceProvider);
	registerPacketBehavior(behaviorPacketData);
}
