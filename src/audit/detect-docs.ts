// Durable-doc drift detectors: unused glossary terms, stale decision
// references and capabilities missing from `specs/product.md`.

import { parseDecision } from "../core/decision.ts";
import { parseGlossary } from "../core/glossary.ts";
import { splitLines } from "../core/lines.ts";
import { type DriftItem, driftItem } from "./items.ts";
import { livingSpecs, readFiles } from "./living-specs.ts";
import type { RepoView } from "./repo-view.ts";

const GLOSSARY = "specs/glossary.md";
const PRODUCT = "specs/product.md";
const DECISION_FILE = /^specs\/decisions\/[^/]+\.md$/;
const SUPERSEDED_WORD = /\bsuperseded\b/i;

export async function detectDocs(view: RepoView): Promise<DriftItem[]> {
	return [...(await unusedTerms(view)), ...(await staleDecisions(view)), ...(await productMissing(view))];
}

async function unusedTerms(view: RepoView): Promise<DriftItem[]> {
	const text = await view.read(GLOSSARY);
	if (text === undefined) return [];
	const entries = parseGlossary(text).entries;
	if (entries.length === 0) return [];
	const others = (await readFiles(view, (p) => p !== GLOSSARY)).map((f) => f.text.toLowerCase());
	return entries
		.filter((e) => !others.some((t) => t.includes(e.term.toLowerCase())))
		.map((e) => driftItem("unused-term", e.term, `${GLOSSARY}:${e.line} term "${e.term}" occurs in no other file`));
}

type Superseded = { name: string; file: string; pattern: RegExp };

async function supersededDecisions(view: RepoView): Promise<Superseded[]> {
	const found: Superseded[] = [];
	for (const file of view.files.filter((f) => DECISION_FILE.test(f))) {
		const text = await view.read(file);
		if (text === undefined) continue;
		const d = parseDecision(file, text);
		if (d.status !== "superseded" || Number.isNaN(d.number)) continue;
		const name = (file.split("/").pop() ?? file).replace(/\.md$/, "");
		const number = name.slice(0, name.indexOf("-"));
		const pattern = new RegExp(`(?<![\\w-])(?:${escapeRegExp(name)}(?![\\w-])|decisions/${escapeRegExp(number)}-)`);
		found.push({ name, file, pattern });
	}
	return found;
}

async function staleDecisions(view: RepoView): Promise<DriftItem[]> {
	const superseded = await supersededDecisions(view);
	if (superseded.length === 0) return [];
	const specsFiles = await readFiles(view, (p) => p.startsWith("specs/"));
	const items: DriftItem[] = [];
	for (const d of superseded) {
		for (const f of specsFiles) {
			if (f.path === d.file) continue;
			const at = splitLines(f.text).findIndex((l) => d.pattern.test(l.text) && !SUPERSEDED_WORD.test(l.text));
			if (at !== -1) items.push(driftItem("stale-decision", `${d.name}@${f.path}`, `${f.path}:${at + 1} names superseded decision ${d.name}`));
		}
	}
	return items;
}

async function productMissing(view: RepoView): Promise<DriftItem[]> {
	const product = await view.read(PRODUCT);
	if (product === undefined) return [];
	const lower = product.toLowerCase();
	return (await livingSpecs(view))
		.filter(({ spec }) => !lower.includes(spec.capability.toLowerCase()))
		.map(({ file, spec }) => driftItem("product-missing", spec.capability, `${file} has a living spec but ${PRODUCT} never names ${spec.capability}`, spec.capability));
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
