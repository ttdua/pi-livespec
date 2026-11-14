import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LineCounter, parseDocument, isMap, isScalar } from "yaml";
import { type Merged, type Origin, type ParsedPack, mergePack, standalonePack } from "./pack-merge.ts";
import { validatePackDocument } from "./pack-schema.ts";
import type { LoadedPack, PackError } from "./pack-types.ts";

const DEFAULT_PACK_FILE = "src/packs/agent-skills.yaml";
const OVERRIDE_FILE = ".pi/livespec/flow.yaml";

type ReadFile = (p: string) => Promise<string | undefined>;
type Deps = { readFile?: ReadFile };
type Parsed = { parsed: ParsedPack; errors: PackError[] };

async function readFs(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
}

function parse(text: string, file: string, mode: "pack" | "override"): Parsed {
	const lc = new LineCounter();
	const doc = parseDocument(text, { keepSourceTokens: false, lineCounter: lc });
	const errors = validatePackDocument(doc, file, lc, mode);
	const js = doc.toJS({ maxAliasCount: 100 });
	const value = typeof js === "object" && js !== null && !Array.isArray(js) ? (js as Record<string, unknown>) : {};
	return { parsed: { file, value, lc, doc }, errors };
}

/** An override with no `extends` is a complete pack; an empty or scalar file stays an override error. */
function overrideMode(text: string): "pack" | "override" {
	const doc = parseDocument(text);
	if (!isMap(doc.contents)) return "override";
	const hasExtends = doc.contents.items.some((p) => isScalar(p.key) && p.key.value === "extends");
	return hasExtends ? "override" : "pack";
}

function errorAt(origin: Origin | undefined, fallback: string, path: string, message: string): PackError {
	return { severity: "error", file: origin?.file ?? fallback, line: origin?.line ?? 1, col: origin?.col ?? 1, path, message };
}

function findCycle(graph: Map<string, string[]>): string[] | undefined {
	const state = new Map<string, "open" | "done">();
	const stack: string[] = [];
	const visit = (id: string): string[] | undefined => {
		if (state.get(id) === "done") return undefined;
		if (state.get(id) === "open") return [...stack.slice(stack.indexOf(id)), id];
		state.set(id, "open");
		stack.push(id);
		for (const next of graph.get(id) ?? []) {
			const cycle = graph.has(next) ? visit(next) : undefined;
			if (cycle) return cycle;
		}
		stack.pop();
		state.set(id, "done");
		return undefined;
	};
	for (const id of graph.keys()) {
		const cycle = visit(id);
		if (cycle) return cycle;
	}
	return undefined;
}

function semanticErrors({ pack, origins }: Merged, file: string): PackError[] {
	const errors: PackError[] = [];
	const ids = new Set(pack.phases.map((p) => p.id));
	const graph = new Map<string, string[]>();
	for (const phase of pack.phases) {
		graph.set(phase.id, phase.requires);
		const origin = origins.get(`phases.${phase.id}.requires`) ?? origins.get(`phases.${phase.id}`);
		for (const req of phase.requires) {
			if (!ids.has(req)) errors.push(errorAt(origin, file, `phases.${phase.id}.requires`, `phase \`${phase.id}\` requires unknown phase \`${req}\``));
		}
	}
	const cycle = findCycle(graph);
	if (cycle) {
		const first = cycle[0] as string;
		const origin = origins.get(`phases.${first}.requires`) ?? origins.get(`phases.${first}`);
		errors.push(errorAt(origin, file, `phases.${first}.requires`, `requires cycle: ${cycle.join(" -> ")}`));
	}
	return errors;
}

function finish(merged: Merged, file: string, carried: PackError[]): LoadedPack {
	const all = [...carried, ...semanticErrors(merged, file)];
	const errors = all.filter((e) => e.severity === "error");
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, pack: merged.pack, warnings: all.filter((e) => e.severity === "warning") };
}

async function readDefault(read: ReadFile | undefined): Promise<string> {
	const url = new URL("../packs/agent-skills.yaml", import.meta.url);
	const text = (await read?.(url.pathname)) ?? (await readFs(url.pathname));
	if (text === undefined) throw new Error(`default pack missing: ${DEFAULT_PACK_FILE}`);
	return text;
}

export async function loadPack(root: string, deps: Deps = {}): Promise<LoadedPack> {
	const base = parse(await readDefault(deps.readFile), DEFAULT_PACK_FILE, "pack");
	const baseErrors = base.errors.filter((e) => e.severity === "error");
	if (baseErrors.length > 0) return { ok: false, errors: baseErrors };

	const overridePath = join(root, OVERRIDE_FILE);
	const text = await (deps.readFile ?? readFs)(overridePath);
	if (text === undefined) return finish(standalonePack(base.parsed), DEFAULT_PACK_FILE, base.errors);

	const mode = overrideMode(text);
	const over = parse(text, OVERRIDE_FILE, mode);
	if (over.errors.some((e) => e.severity === "error")) return { ok: false, errors: over.errors.filter((e) => e.severity === "error") };
	const carried = [...base.errors, ...over.errors];
	if (mode === "pack") return finish(standalonePack(over.parsed), OVERRIDE_FILE, carried);
	return finish(mergePack(base.parsed, over.parsed), OVERRIDE_FILE, carried);
}
