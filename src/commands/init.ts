// `/livespec init`: writes the missing starter files and clones agent-skills when
// no clone exists. Existing files are never touched, so a rerun finishes a
// partly failed run.

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloneResult, ContentManager } from "../content/manager.ts";
import type { LoadedPack } from "../engine/pack-types.ts";
import { formatPackError, messageOf } from "./messages.ts";
import {
	CONFIG_TEMPLATE,
	CONSTRAINTS_TEMPLATE,
	DECISIONS_KEEP_FILE,
	GLOSSARY_TEMPLATE,
	PRODUCT_TEMPLATE,
} from "./init-templates.ts";

export type InitDeps = { content: Pick<ContentManager, "clone" | "activeTree">; pack: () => Promise<LoadedPack> };
export type InitFailure = { path: string; reason: string };
export type InitReport = { created: string[]; kept: string[]; failed: InitFailure[] };

/** The report entry for the shared agent-skills clone. */
export const CLONE_ENTRY = "agent-skills";
const DECISIONS_DIR = "specs/decisions/";

const FILE_TEMPLATES: readonly { path: string; content: string }[] = [
	{ path: "specs/product.md", content: PRODUCT_TEMPLATE },
	{ path: "specs/glossary.md", content: GLOSSARY_TEMPLATE },
	{ path: "specs/constraints.md", content: CONSTRAINTS_TEMPLATE },
];
const CONFIG_FILE = { path: ".pi/livespec/config.yaml", content: CONFIG_TEMPLATE };

type Outcome = "created" | "kept" | { reason: string };

export async function runInit(root: string, d: InitDeps): Promise<InitReport> {
	const report: InitReport = { created: [], kept: [], failed: [] };
	const record = (path: string, outcome: Outcome) => {
		if (outcome === "created" || outcome === "kept") report[outcome].push(path);
		else report.failed.push({ path, reason: outcome.reason });
	};
	for (const file of FILE_TEMPLATES) record(file.path, await writeIfMissing(root, file.path, file.content));
	record(DECISIONS_DIR, await ensureDecisionsDir(root));
	record(CONFIG_FILE.path, await writeIfMissing(root, CONFIG_FILE.path, CONFIG_FILE.content));
	record(CLONE_ENTRY, await ensureClone(d));
	return report;
}

/** `wx` creates the file only when absent, so an existing file is never rewritten. */
async function writeIfMissing(root: string, rel: string, content: string): Promise<Outcome> {
	const path = join(root, rel);
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, { encoding: "utf8", flag: "wx" });
		return "created";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return "kept";
		return { reason: messageOf(error) };
	}
}

/** An existing `specs/decisions/` is kept as is; a new one gets a keep file so git tracks it. */
async function ensureDecisionsDir(root: string): Promise<Outcome> {
	const dir = join(root, DECISIONS_DIR);
	try {
		if ((await stat(dir)).isDirectory()) return "kept";
		return { reason: `${DECISIONS_DIR} exists and is not a directory` };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { reason: messageOf(error) };
	}
	return writeIfMissing(root, join(DECISIONS_DIR, DECISIONS_KEEP_FILE), "");
}

async function ensureClone(d: InitDeps): Promise<Outcome> {
	try {
		if ((await d.content.activeTree()) !== undefined) return "kept";
		const loaded = await d.pack();
		if (!loaded.ok) return { reason: `the flow pack is invalid: ${loaded.errors.map(formatPackError).join("; ")}` };
		return cloneOutcome(await d.content.clone(loaded.pack));
	} catch (error) {
		return { reason: messageOf(error) };
	}
}

function cloneOutcome(r: CloneResult): Outcome {
	if (r.kind === "installed") return "created";
	if (r.kind === "exists") return "kept";
	const items = r.failures?.map((f) => `${f.item}: ${f.reason}`) ?? [];
	return { reason: [r.reason, ...items].join("; ") };
}

