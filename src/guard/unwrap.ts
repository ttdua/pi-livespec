// The one way the guard recognizes the command a simple command really runs:
// wrapper commands (`env`, `sudo`, `xargs` …) are removed, and the command word
// is compared by basename without a leading backslash (design D7).

import { scanOptions, set } from "./options.ts";
import type { Word } from "./shell.ts";

export const UNWRAP_DEPTH = 8;

type Wrapper = { valued: ReadonlySet<string>; skipOperands?: (operands: Word[]) => number };

const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map<string, Wrapper>([
	["env", { valued: set("-u", "--unset", "-C", "--chdir"), skipOperands: (ops) => countWhile(ops, (w) => ASSIGNMENT_WORD.test(w.text)) }],
	["command", { valued: set() }],
	["exec", { valued: set("-a") }],
	["nice", { valued: set("-n", "--adjustment") }],
	["nohup", { valued: set() }],
	["time", { valued: set("-f", "-o", "--format", "--output") }],
	["timeout", { valued: set("-s", "-k", "--signal", "--kill-after"), skipOperands: () => 1 }],
	["sudo", { valued: set("-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group", "--host", "--prompt", "--chdir", "--role", "--type", "--other-user", "--command-timeout", "--close-from") }],
	["xargs", { valued: set("-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--max-chars", "--delimiter", "--arg-file", "--max-lines", "--replace", "--eof") }],
]);

/** The command word compared by basename, with a leading `\` stripped. */
export function commandName(w: Word | undefined): string {
	if (!w) return "";
	const text = w.text.replace(/^\\/, "");
	return text.slice(text.lastIndexOf("/") + 1);
}

/** The words of the command a wrapper chain runs; "too-deep" when wrappers nest beyond UNWRAP_DEPTH. */
export function stripWrappers(words: Word[]): Word[] | "too-deep" {
	let current = words;
	for (let level = 0; level <= UNWRAP_DEPTH; level++) {
		const head = current[0];
		const wrapper = head && !head.expansion ? WRAPPERS.get(commandName(head)) : undefined;
		if (!wrapper) return current;
		const { operands } = scanOptions(current.slice(1), wrapper.valued, true);
		current = operands.slice(wrapper.skipOperands?.(operands) ?? 0);
	}
	return "too-deep";
}

function countWhile(words: Word[], pred: (w: Word) => boolean): number {
	const index = words.findIndex((w) => !pred(w));
	return index < 0 ? words.length : index;
}
