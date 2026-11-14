import { type Document, type LineCounter, type Node, isMap, isScalar, isSeq } from "yaml";
import type { Pack, Phase } from "./pack-types.ts";

export type ParsedPack = {
	file: string;
	value: Record<string, unknown>;
	lc: LineCounter;
	doc: Document;
};
export type Origin = { file: string; line: number; col: number };
export type Merged = { pack: Pack; origins: Map<string, Origin> };

type Raw = Record<string, unknown>;
const MAP_KEYS = ["limits", "loops", "decisions", "init"] as const;

function isRaw(v: unknown): v is Raw {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rawPhases(value: Raw): Raw[] {
	return Array.isArray(value.phases) ? value.phases.filter(isRaw) : [];
}

/** Fills absent phase keys: `[]` for lists, `gate: "none"`. */
function normalizePhase(raw: Raw): Phase {
	const skills = isRaw(raw.skills) ? raw.skills : {};
	const phase: Phase = {
		id: String(raw.id),
		requires: (raw.requires as string[] | undefined) ?? [],
		skills: {
			required: (skills.required as string[] | undefined) ?? [],
			optional: (skills.optional as string[] | undefined) ?? [],
		},
		outputs: (raw.outputs as Phase["outputs"] | undefined) ?? [],
		redirects: (raw.redirects as string[] | undefined) ?? [],
		checks: (raw.checks as string[] | undefined) ?? [],
		gate: (raw.gate as Phase["gate"] | undefined) ?? "none",
		subagents: (raw.subagents as unknown[] | undefined) ?? [],
	};
	if (raw.per === "unit") phase.per = "unit";
	return phase;
}

function mergePhase(base: Raw, over: Raw): Raw {
	const merged: Raw = { ...base, ...over };
	if (isRaw(base.skills) || isRaw(over.skills)) {
		merged.skills = { ...(isRaw(base.skills) ? base.skills : {}), ...(isRaw(over.skills) ? over.skills : {}) };
	}
	return merged;
}

function mergePhases(base: Raw[], over: Raw[]): Raw[] {
	const result = [...base];
	for (const phase of over) {
		const at = result.findIndex((p) => p.id === phase.id);
		if (at >= 0) result[at] = mergePhase(result[at] as Raw, phase);
		else result.push(phase);
	}
	return result;
}

function mergeMap(base: unknown, over: unknown): Raw {
	return { ...(isRaw(base) ? base : {}), ...(isRaw(over) ? over : {}) };
}

function assemble(value: Raw, phases: Raw[]): Pack {
	const init = isRaw(value.init) ? value.init : {};
	return {
		name: String(value.name),
		version: 1,
		content: String(value.content),
		limits: mergeMap(undefined, value.limits) as Record<string, number>,
		loops: mergeMap(undefined, value.loops) as Record<string, number>,
		decisions: mergeMap(undefined, value.decisions),
		init: { skills: (init.skills as string[] | undefined) ?? [] },
		phases: phases.map(normalizePhase),
	};
}

function originOf(p: ParsedPack, node: Node | null | undefined): Origin {
	const { line, col } = p.lc.linePos(node?.range?.[0] ?? 0);
	return { file: p.file, line, col };
}

/** Records `phases.<id>`, `phases.<id>.<key>` and `<map>.<key>` origins of one parsed file. */
function collectOrigins(p: ParsedPack, into: Map<string, Origin>): void {
	const root = p.doc.contents;
	if (!isMap(root)) return;
	for (const pair of root.items) {
		const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
		if (!key) continue;
		into.set(key, originOf(p, pair.key as Node));
		if (key === "phases" && isSeq(pair.value)) collectPhaseOrigins(p, pair.value.items as Node[], into);
		else if (isMap(pair.value)) {
			for (const inner of pair.value.items) {
				if (isScalar(inner.key)) into.set(`${key}.${String(inner.key.value)}`, originOf(p, inner.key as Node));
			}
		}
	}
}

function collectPhaseOrigins(p: ParsedPack, items: Node[], into: Map<string, Origin>): void {
	for (const item of items) {
		if (!isMap(item)) continue;
		const idPair = item.items.find((i) => isScalar(i.key) && i.key.value === "id");
		const id = isScalar(idPair?.value) ? String(idPair.value.value) : undefined;
		if (!id) continue;
		into.set(`phases.${id}`, originOf(p, idPair?.value as Node));
		for (const pair of item.items) {
			if (isScalar(pair.key)) into.set(`phases.${id}.${String(pair.key.value)}`, originOf(p, (pair.value ?? pair.key) as Node));
		}
	}
}

export function standalonePack(parsed: ParsedPack): Merged {
	const origins = new Map<string, Origin>();
	collectOrigins(parsed, origins);
	return { pack: assemble(parsed.value, rawPhases(parsed.value)), origins };
}

export function mergePack(base: ParsedPack, override: ParsedPack): Merged {
	const origins = new Map<string, Origin>();
	collectOrigins(base, origins);
	collectOrigins(override, origins);
	const merged: Raw = { ...base.value };
	for (const key of MAP_KEYS) {
		if (key in override.value || key in base.value) merged[key] = mergeMap(base.value[key], override.value[key]);
	}
	const phases = mergePhases(rawPhases(base.value), rawPhases(override.value));
	return { pack: assemble(merged, phases), origins };
}
