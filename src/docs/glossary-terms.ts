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
const FRONT_DELIMITER = "---";

type AddedLine = { file: string; line: string; no: number };

/** Added (`+`) lines of the files `keep` selects, with their line number in the new file. */
function addedLines(diff: string, keep: (file: string) => boolean): AddedLine[] {
	const out: AddedLine[] = [];
	let file = "";
	let inHunk = false;
	let newLine = 0;
	for (const raw of diff.split(/\r?\n/)) {
		if (raw.startsWith("diff --git ")) {
			file = "";
			inHunk = false;
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
		if (raw.startsWith("+") && keep(file)) out.push({ file, line: raw.slice(1), no: newLine });
		newLine += 1;
	}
	return out;
}

/** Files under `specs/<capability>/spec.md` that the diff adds lines to, in diff order. */
function specFilesOf(diff: string): string[] {
	return [...new Set(addedLines(diff, (f) => SPEC_FILE.test(f)).map((a) => a.file))];
}

/** Last line number of the front matter at the start of `content` (its closing delimiter); 0 when there is none. */
export function frontMatterEnd(content: string): number {
	const lines = content.split(/\r?\n/);
	if (lines[0] !== FRONT_DELIMITER) return 0;
	const close = lines.indexOf(FRONT_DELIMITER, 1);
	return close === -1 ? 0 : close + 1;
}

/** The `+` lines of `specs/<capability>/spec.md` files outside front matter; `frontEnds` maps each file to its `frontMatterEnd` at HEAD. */
export function addedSpecLines(diff: string, frontEnds: Map<string, number>): AddedLine[] {
	return addedLines(diff, (f) => SPEC_FILE.test(f)).filter((a) => a.no > (frontEnds.get(a.file) ?? 0));
}

/** The `- **Term**: …` entries the diff adds to `specs/glossary.md`. */
export function addedGlossaryEntries(diff: string): string[] {
	return addedLines(diff, (f) => f === GLOSSARY_FILE)
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
const HEADING = /^\s*#/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s/;
const INDENTED = /^\s+\S/;
const SENTENCE_END = /[.!?:]\s*$/;

function boldTerms(line: string): string[] {
	return [...line.matchAll(BOLD)].map((m) => (m[1] ?? "").trim()).filter((t) => t !== "" && !SCENARIO_KEYWORDS.has(t));
}

/**
 * True when `line` carries on the sentence of the previous line. A list item's text continues only on an indented
 * line; headings, list items and blank lines never continue, and a line ending with `.`, `!`, `?` or `:` ends a sentence.
 */
function continuesSentence(prev: string | undefined, line: string): boolean {
	if (prev === undefined || prev.trim() === "") return false;
	if (HEADING.test(prev) || HEADING.test(line) || LIST_ITEM.test(line)) return false;
	if (LIST_ITEM.test(prev) && !INDENTED.test(line)) return false;
	return !SENTENCE_END.test(prev);
}

/** Capitalized, not all-capital words that are not the first word of a sentence. */
function properNouns(line: string, startsSentence: boolean): string[] {
	const prose = line.replace(/`[^`]*`/g, " ").replace(BOLD, " ").replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");
	const found: string[] = [];
	let sentenceStart = startsSentence;
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

/**
 * Candidate terms in `added` that the glossary lacks; proper nouns count only when absent from `knownAtBase`.
 * `added` lines are consecutive; a blank separator between files keeps sentences from spanning them.
 */
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
	let prev: string | undefined;
	for (const line of added) {
		const startsSentence = !continuesSentence(prev, line);
		prev = line;
		boldTerms(line).forEach(take);
		if (HEADING.test(line)) continue;
		for (const noun of properNouns(line, startsSentence)) if (!occursIn(noun, knownAtBase)) take(noun);
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

/**
 * The added spec lines of `Base..HEAD` with front matter read from HEAD. A blank separator goes between lines that
 * are not adjacent in the same file (another file, a new hunk, or unadded lines between), so sentences never join.
 */
async function addedSpecText(git: Parameters<CheckFn>[0]["git"], base: string): Promise<string[]> {
	const diff = await git.diff(base, "HEAD", SPECS_PATH);
	const frontEnds = new Map<string, number>();
	for (const file of specFilesOf(diff)) frontEnds.set(file, frontMatterEnd((await git.showFile("HEAD", file)) ?? ""));
	const out: string[] = [];
	let prev: AddedLine | undefined;
	for (const added of addedSpecLines(diff, frontEnds)) {
		if (prev !== undefined && (added.file !== prev.file || added.no !== prev.no + 1)) out.push("");
		out.push(added.line);
		prev = added;
	}
	return out;
}

/** `glossary-terms`: a warning per candidate the glossary lacks; a git failure is one warning; never an error. */
export const glossaryTermsCheck: CheckFn = async ({ root, change, git }) => {
	const base = change.header.base;
	if (base === undefined) return [];
	try {
		const added = await addedSpecText(git, base);
		if (added.every((l) => l === "")) return [];
		const [glossary, known] = await Promise.all([readGlossary(root), specsTextAt(git, base)]);
		return glossaryCandidates(added, glossary, known).map(
			(term): Result => ({ code: "glossary-terms", severity: "warning", file: GLOSSARY_FILE, message: `New term "${term}" has no entry in ${GLOSSARY_FILE}` }),
		);
	} catch (error) {
		if (error instanceof GitError) return [gitWarning(error)];
		throw error;
	}
};

const gitWarning = (error: GitError): Result => ({
	code: "glossary-terms",
	severity: "warning",
	file: GLOSSARY_FILE,
	message: `glossary-terms check skipped: ${error.message}`,
});
