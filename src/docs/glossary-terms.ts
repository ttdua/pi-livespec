// `glossary-terms` check: new terms the specs diff introduces that the glossary lacks.
// Pure helpers over diff text; `glossaryTermsCheck` is the thin I/O wrapper.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Glossary } from "../core/glossary.ts";
import { parseGlossary } from "../core/glossary.ts";
import type { Result } from "../core/result.ts";
import { GitError } from "../engine/git.ts";
import type { CheckFn } from "../engine/registry.ts";

const SPECS_PATH = "specs/";
const SPEC_FILE = /^specs\/[^/]+\/spec\.md$/;
const GLOSSARY_FILE = "specs/glossary.md";
const SCENARIO_KEYWORDS = new Set(["WHEN", "THEN", "AND", "GIVEN"]);
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const GLOSSARY_ENTRY = /^- \*\*.+?\*\*:/;

type AddedLine = { file: string; line: string };

/** Added (`+`) lines per file of a unified diff; `keep` selects the files and `frontMatter` drops front matter lines. */
function addedLines(diff: string, keep: (file: string) => boolean, frontMatter: boolean): AddedLine[] {
	const out: AddedLine[] = [];
	let file = "";
	let inHunk = false;
	let newLine = 0;
	let front: "open" | "closed" = "closed";
	for (const raw of diff.split(/\r?\n/)) {
		if (raw.startsWith("diff --git ")) {
			file = "";
			inHunk = false;
			front = "closed";
			continue;
		}
		if (!inHunk && raw.startsWith("+++ ")) {
			file = raw === "+++ /dev/null" ? "" : raw.slice("+++ b/".length);
			continue;
		}
		const hunk = HUNK.exec(raw);
		if (hunk) {
			inHunk = true;
			newLine = Number(hunk[1]);
			continue;
		}
		if (!inHunk || raw.startsWith("-") || raw.startsWith("\\")) continue;
		const text = raw.slice(1);
		const added = raw.startsWith("+");
		let inFront = false;
		if (newLine === 1) {
			front = text === "---" ? "open" : "closed";
			inFront = front === "open";
		} else if (front === "open") {
			inFront = true;
			if (text === "---") front = "closed";
		}
		inFront = frontMatter && inFront;
		if (added && keep(file) && !inFront) out.push({ file, line: text });
		newLine += 1;
	}
	return out;
}

/** The `+` lines of `specs/<capability>/spec.md` files outside front matter. */
export function addedSpecLines(diff: string): AddedLine[] {
	return addedLines(diff, (f) => SPEC_FILE.test(f), true);
}

/** The `- **Term**: …` entries the diff adds to `specs/glossary.md`. */
export function addedGlossaryEntries(diff: string): string[] {
	return addedLines(diff, (f) => f === GLOSSARY_FILE, false)
		.map((a) => a.line)
		.filter((l) => GLOSSARY_ENTRY.test(l));
}

const normalise = (term: string): string => term.toLowerCase().replace(/s$/, "");

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A word-boundary match where `-` belongs to the word. */
function occursIn(term: string, text: string): boolean {
	return new RegExp(`(?<![\\w-])${escapeRegExp(term)}(?![\\w-])`, "i").test(text);
}

const BOLD = /\*\*([^*]+)\*\*/g;
const WORD = /[A-Za-z][\w'-]*/g;

function boldTerms(line: string): string[] {
	return [...line.matchAll(BOLD)].map((m) => (m[1] ?? "").trim()).filter((t) => t !== "" && !SCENARIO_KEYWORDS.has(t));
}

/** Capitalized, not all-capital words that are not the first word of a sentence. */
function properNouns(line: string): string[] {
	const prose = line.replace(/`[^`]*`/g, " ").replace(BOLD, " ").replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");
	const found: string[] = [];
	let sentenceStart = true;
	let last = 0;
	for (const m of prose.matchAll(WORD)) {
		const between = prose.slice(last, m.index);
		if (/[.!?]\s*$/.test(between)) sentenceStart = true;
		const word = m[0];
		if (!sentenceStart && /^[A-Z]/.test(word) && word !== word.toUpperCase()) found.push(word);
		sentenceStart = false;
		last = (m.index ?? 0) + word.length;
	}
	return found;
}

/** Candidate terms in `added` that the glossary lacks; proper nouns count only when absent from `knownAtBase`. */
export function glossaryCandidates(added: string[], glossary: Glossary, knownAtBase: string): string[] {
	const known = new Set(glossary.entries.map((e) => normalise(e.term)));
	const seen = new Set<string>();
	const out: string[] = [];
	const take = (term: string): void => {
		const key = normalise(term);
		if (known.has(key) || seen.has(key)) return;
		seen.add(key);
		out.push(term);
	};
	for (const line of added) {
		if (line.trimStart().startsWith("#")) continue;
		boldTerms(line).forEach(take);
		for (const noun of properNouns(line)) if (!occursIn(noun, knownAtBase)) take(noun);
	}
	return out;
}

async function readGlossary(root: string): Promise<Glossary> {
	try {
		return parseGlossary(await readFile(join(root, GLOSSARY_FILE), "utf8"));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return parseGlossary("");
		throw e;
	}
}

/** Every file under `specs/` at `rev`, concatenated. */
async function specsTextAt(git: Parameters<CheckFn>[0]["git"], rev: string): Promise<string> {
	const files = (await git.listTree(rev)).filter((f) => f.startsWith(SPECS_PATH));
	const texts = await Promise.all(files.map((f) => git.showFile(rev, f)));
	return texts.filter((t): t is string => t !== undefined).join("\n");
}

/** `glossary-terms`: a warning per candidate the glossary lacks; never an error. */
export const glossaryTermsCheck: CheckFn = async ({ root, change, git }) => {
	const base = change.header.base;
	if (base === undefined) return [];
	try {
		const added = addedSpecLines(await git.diff(base, "HEAD", SPECS_PATH)).map((a) => a.line);
		if (added.length === 0) return [];
		const [glossary, known] = await Promise.all([readGlossary(root), specsTextAt(git, base)]);
		return glossaryCandidates(added, glossary, known).map(
			(term): Result => ({ code: "glossary-terms", severity: "warning", file: GLOSSARY_FILE, message: `New term "${term}" has no entry in ${GLOSSARY_FILE}` }),
		);
	} catch (error) {
		if (error instanceof GitError) return [];
		throw error;
	}
};
