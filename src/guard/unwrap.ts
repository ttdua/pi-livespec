// The one way the guard recognizes the command a simple command really runs:
// wrapper commands (`env`, `sudo`, `xargs` …) are removed, and the command word
// is compared by basename without a leading backslash (design D7). A wrapper
// that runs a script (`env -S`, `flock -c`) yields that script for re-parsing.

import { splitEnvString } from "./envsplit.ts";
import { optionValues, type Scanned, scanOptions, set } from "./options.ts";
import type { Word } from "./shell.ts";

export const UNWRAP_DEPTH = 8;

/** What a wrapper chain runs: more words, a script text to parse again, or wrappers nested too deep. */
export type Unwrapped = Word[] | { script: Word } | "too-deep";

type Wrapper = {
	valued: ReadonlySet<string>;
	skipOperands?: (operands: Word[]) => number;
	/** The script the wrapper runs instead of its operands, when it has one. */
	script?: (scanned: Scanned) => Word | undefined;
};

const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_SPLIT = set("-S", "--split-string");
const FLOCK_COMMAND = set("-c", "--command");
const FLOCK_VALUED = set("-w", "--wait", "--timeout", "-E", "--conflict-exit-code", ...FLOCK_COMMAND);

const CHDIR_LONG = ["--ch", "--chd", "--chdi", "--chdir"];
/** Per wrapper, the options that change the directory the wrapped command runs in. */
const CHDIR_OPTIONS: Record<string, ReadonlySet<string>> = { env: set("-C", ...CHDIR_LONG), sudo: set("-D", ...CHDIR_LONG) };

const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map<string, Wrapper>([
	["env", { valued: set("-u", "--unset", "-C", ...CHDIR_LONG, ...ENV_SPLIT), skipOperands: (ops) => countWhile(ops, (w) => ASSIGNMENT_WORD.test(w.text)), script: envSplitScript }],
	["command", { valued: set() }],
	["exec", { valued: set("-a") }],
	["nice", { valued: set("-n", "--adjustment") }],
	["nohup", { valued: set() }],
	["setsid", { valued: set() }],
	["stdbuf", { valued: set("-i", "-o", "-e", "--input", "--output", "--error") }],
	["ionice", { valued: set("-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid") }],
	["doas", { valued: set("-u", "-a", "-C") }],
	["flock", { valued: FLOCK_VALUED, skipOperands: () => 1, script: flockScript }],
	["time", { valued: set("-f", "-o", "--format", "--output") }],
	["timeout", { valued: set("-s", "-k", "--signal", "--kill-after"), skipOperands: () => 1 }],
	["sudo", { valued: set("-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group", "--host", "--prompt", ...CHDIR_LONG, "--role", "--type", "--other-user", "--command-timeout", "--close-from") }],
	["xargs", { valued: set("-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--max-chars", "--delimiter", "--arg-file", "--max-lines", "--replace", "--eof") }],
]);

/** The command word compared by basename, with a leading `\` stripped. */
export function commandName(w: Word | undefined): string {
	if (!w) return "";
	const text = w.text.replace(/^\\/, "");
	return text.slice(text.lastIndexOf("/") + 1);
}

/** The words of the command a wrapper chain runs, or the script a wrapper runs; "too-deep" beyond UNWRAP_DEPTH. */
export function stripWrappers(words: Word[]): Unwrapped {
	return walkWrappers(words).result;
}

/** The directory values of `env -C`/`--chdir` and `sudo -D`/`--chdir` met along the wrapper chain, outermost first. */
export function chdirValues(words: Word[]): Word[] {
	return walkWrappers(words).chdirs;
}

function walkWrappers(words: Word[]): { result: Unwrapped; chdirs: Word[] } {
	const chdirs: Word[] = [];
	let current = words;
	for (let level = 0; level <= UNWRAP_DEPTH; level++) {
		const head = current[0];
		const wrapper = head && !head.expansion ? WRAPPERS.get(commandName(head)) : undefined;
		if (!wrapper) return { result: current, chdirs };
		const scanned = scanOptions(current.slice(1), wrapper.valued, true);
		const chdir = CHDIR_OPTIONS[commandName(head)];
		if (chdir) chdirs.push(...optionValues(scanned, chdir));
		const script = wrapper.script?.(scanned);
		if (script) return { result: { script }, chdirs };
		current = scanned.operands.slice(wrapper.skipOperands?.(scanned.operands) ?? 0);
	}
	return { result: "too-deep", chdirs };
}

/** `env -S <string> [args…]`: env splits the string by its own rules (not the shell's); the operands follow it. */
function envSplitScript(scanned: Scanned): Word | undefined {
	const split = optionValues(scanned, ENV_SPLIT).at(-1);
	if (!split) return undefined;
	const all = [split, ...scanned.operands];
	const words = split.expansion ? "unreadable" : splitEnvString(split.text);
	// Unreadable text is handed over as an expansion, so it is obscured when it holds a dangerous token.
	const expansion = words === "unreadable" || all.some((w) => w.expansion);
	const parts = words === "unreadable" ? [decodeSureSeparators(split.text)] : words.map((t) => quoteWord({ ...split, text: t, expansion: false }));
	return { text: ["env", ...parts, ...scanned.operands.map(quoteWord)].join(" "), quoted: true, expansion };
}

/** Unreadable `env -S` text with its sure separators (`\_`, `\t`, `\n`) as spaces and quotes and backslashes dropped, for the token scan. */
function decodeSureSeparators(text: string): string {
	return text.replace(/\\[_tn]/g, " ").replace(/['"\\]/g, "");
}

/** `flock [opts] -c <script> <file>`, or the script in `-c`/`--command` anywhere after the lock operand. */
function flockScript(scanned: Scanned): Word | undefined {
	const option = optionValues(scanned, FLOCK_COMMAND).at(-1);
	if (option) return option;
	const [lock, ...rest] = scanned.operands;
	if (!lock || rest.length === 0) return undefined;
	const after = scanOptions(rest, FLOCK_VALUED, false);
	return optionValues(after, FLOCK_COMMAND).at(-1);
}

/** A word as shell text: an expansion keeps its raw text, anything else is single-quoted. */
function quoteWord(w: Word): string {
	return w.expansion ? w.text : `'${w.text.replaceAll("'", `'\\''`)}'`;
}

function countWhile(words: Word[], pred: (w: Word) => boolean): number {
	const index = words.findIndex((w) => !pred(w));
	return index < 0 ? words.length : index;
}
