// Builds a packet from the change state: layers, sources, budget and spill files, hash.

import { roleSkillPaths } from "./flow.ts";
import { renderFooter, renderPrefix, renderTask, tokensOf, type Spilled } from "./render.ts";
import type { ReviewSubject, Role } from "./roles.ts";
import { humanComments, sha256 } from "./source-kit.ts";
import type { Packet, PacketContext, PacketResult, PacketSource, Placed, Target } from "./source-types.ts";
import { seenKey } from "./freshness.ts";
import { collectSources } from "./sources.ts";
import { spillDirectory, spillName, SPILL_PLACEHOLDER, writeSpills } from "./spill.ts";
import { unitText } from "./sources-change.ts";
import { resolveTarget } from "./target.ts";
import { makeReads } from "./source-kit.ts";

export { roleSkillPaths };
export { registerPacketSource } from "./sources.ts";
export type { Packet, PacketContext, PacketSource } from "./source-types.ts";

/** A zero hash stands in while the budget is fitted: the real hash and its directory have the same length, so the sizes agree. */
const SIZING_HASH = "0".repeat(64);

type Plan = { target: Target; skills: string[]; skillPaths: string[]; placed: Placed[]; unit: string | undefined };

/** Indexes (into `placed`) that live in a file: always the `file` sources, plus the ones spilled for budget. */
type Spill = Set<number>;

function render(ctx: PacketContext, plan: Plan, spill: Spill, dir: string, hash: string): { text: string; body: string } {
	const names = (i: number): string => spillName(i, plan.placed[i]?.source.id ?? "");
	const inline = plan.placed.filter((_, i) => !spill.has(i)).map((p) => p.source);
	const spilled: Spilled[] = plan.placed.flatMap((p, i) => (spill.has(i) ? [{ source: p.source, path: `${dir}/${names(i)}` }] : []));
	const flow = { pack: ctx.pack, tree: ctx.session.activeTree, skills: plan.skills };
	const unitBlock = plan.target.unit ? unitText({ ctx, target: plan.target, reads: makeReads(ctx.forge) }, plan.target.unit) : undefined;
	const task = renderTask({ target: plan.target, unitText: unitBlock, inline, spilled, ...(plan.target.unit?.verify ? { verify: plan.target.unit.verify } : {}), files: plan.target.unit?.files ?? [] });
	const body = renderPrefix(flow) + task;
	return { body, text: body + renderFooter(hash, plan.placed.map((p) => p.source)) };
}

/** Spills inline sources in reverse manifest order until the packet fits; undefined when even that cannot make it fit. */
function fit(ctx: PacketContext, plan: Plan, sizingDir: string): { spill: Spill; tokens: number } | { tokens: number } {
	const spill: Spill = new Set(plan.placed.flatMap((p, i) => (p.place === "file" ? [i] : [])));
	const sized = (): number => tokensOf(render(ctx, plan, spill, sizingDir, SIZING_HASH).text);
	const candidates = plan.placed.flatMap((p, i) => (p.place === "inline" ? [i] : [])).reverse();
	let tokens = sized();
	for (const i of candidates) {
		if (tokens <= ctx.budgetTokens) break;
		spill.add(i);
		tokens = sized();
	}
	return tokens <= ctx.budgetTokens ? { spill, tokens } : { tokens };
}

/** The hash covers the text without footer (spill paths as `<spill>/<file>`), role, subject, unit and every source id and version. */
function hashOf(body: string, plan: Plan): string {
	const t = plan.target;
	const header = [t.role, t.subject ?? "", plan.unit ?? ""].join("|");
	return sha256([body, header, ...plan.placed.map((p) => `${p.source.id}@${p.source.version}`)].join("\n"));
}

const changeName = (ctx: PacketContext): string => ctx.state.change.header.branch?.split("/").at(-1) || `issue-${ctx.state.issue.number}`;

async function plan(ctx: PacketContext, target: Target): Promise<{ ok: true; plan: Plan } | { ok: false; message: string }> {
	const phase = ctx.state.phase.kind === "ok" ? ctx.state.phase.id : undefined;
	if (phase === undefined) return { ok: false, message: "the change has no single phase, so the role's flow skills are unknown" };
	const skills = roleSkillPaths(ctx.pack, phase, target.role, ctx.session.activeTree, target.subject);
	if (!skills.ok) return { ok: false, message: `skill ${skills.missing.join(", ")} is missing from the active content tree; nothing was launched` };
	return { ok: true, plan: { target, skills: skills.names, skillPaths: skills.paths, placed: await collectSources(ctx, target), unit: target.unit?.id } };
}

export async function buildPacket(ctx: PacketContext, role: Role, unit?: string, subject?: ReviewSubject): Promise<PacketResult> {
	const target = resolveTarget(ctx.state, role, unit, subject);
	if (!target.ok) return target;
	let planned: Awaited<ReturnType<typeof plan>>;
	try {
		planned = await plan(ctx, target.target);
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
	if (!planned.ok) return planned;
	let sizingDir: string;
	try {
		sizingDir = await spillDirectory(ctx.root, changeName(ctx), SIZING_HASH);
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
	const fitted = fit(ctx, planned.plan, sizingDir);
	if (!("spill" in fitted)) return { ok: false, message: `the packet needs ${fitted.tokens} tokens against a budget of ${ctx.budgetTokens} (packetBudgetTokens); nothing was launched` };
	return finish(ctx, planned.plan, fitted.spill);
}

async function finish(ctx: PacketContext, p: Plan, spill: Spill): Promise<PacketResult> {
	const hash = hashOf(render(ctx, p, spill, SPILL_PLACEHOLDER, "").body, p);
	let dir = "";
	try {
		dir = spill.size === 0 ? SPILL_PLACEHOLDER : await spillDirectory(ctx.root, changeName(ctx), hash);
		await writeSpills(dir, [...spill].map((i) => ({ name: spillName(i, p.placed[i]?.source.id ?? ""), source: (p.placed[i] as Placed).source })));
	} catch (error) {
		return { ok: false, message: `cannot write the spill files: ${error instanceof Error ? error.message : String(error)}` };
	}
	const { text } = render(ctx, p, spill, dir, hash);
	const sources = p.placed.map((x, i) => ({ id: x.source.id, version: x.source.version, required: x.source.required, ...(spill.has(i) ? { spill: `${dir}/${spillName(i, x.source.id)}` } : {}) }));
	const packet: Packet = { text, hash, sources, skillPaths: p.skillPaths, cwd: ctx.cwd, seen: (await humanComments(ctx)).map(seenKey) };
	return { ok: true, packet };
}
