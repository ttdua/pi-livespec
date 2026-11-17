// Which paths are livespec project files, and which bash commands write them
// (design D7 "Working directory inside one command"). Resolving symlinks of
// existing parents is the only I/O.

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ShellCommand, Word } from "./shell.ts";
import { commandName, stripWrappers } from "./unwrap.ts";

const LIVESPEC_DIR = join(".pi", "livespec");
const CD_COMMANDS = new Set(["cd", "pushd"]);
/** Commands whose every path argument is written (or removed). */
const ALL_PATHS_WRITTEN = new Set(["tee", "rm", "touch", "mv", "rmdir"]);
/** Commands that remove or move their path arguments, so an ancestor of `.pi/livespec` is a protected target too. */
const TREE_REMOVERS = new Set(["rm", "mv", "rmdir"]);
/** Commands that write only their last path argument, or the `-t DIR` value. */
const LAST_PATH_WRITTEN = new Set(["cp", "ln", "install"]);
/** Redirect operators that only read or duplicate descriptors. */
const READ_REDIRECTS = new Set(["<", "<<", "<<-", "<<<", "<&"]);

/** True when `path`, resolved from `cwd` through `..` and existing symlinks, is `<cwd>/.pi/livespec` or below it. */
export function isLivespecPath(cwd: string, path: string): boolean {
	const root = realResolve(resolve(cwd, LIVESPEC_DIR));
	const target = realResolve(resolve(cwd, path));
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** The first write target under `.pi/livespec/`, tracking `cd`/`pushd` across the commands in source order. */
export function protectedWrite(commands: ShellCommand[], cwd: string): string | undefined {
	const dirs = new DirectoryCandidates(cwd);
	for (const cmd of commands) {
		const hit = dirs.protectedTarget(cmd, effectiveWords(cmd));
		if (hit !== undefined) return hit;
		dirs.follow(effectiveWords(cmd));
	}
	return undefined;
}

/** The words of the command `cmd` really runs, after the shared wrapper unwrapping; a wrapped script is checked by the caller. */
export function effectiveWords(cmd: ShellCommand): Word[] {
	const words = stripWrappers(cmd.words);
	return words === "too-deep" || "script" in words ? cmd.words : words;
}

/** True when `path`, resolved like `isLivespecPath`, is a strict ancestor of `<cwd>/.pi/livespec`. */
function isLivespecAncestor(cwd: string, path: string): boolean {
	const rel = relative(realResolve(resolve(cwd, path)), realResolve(resolve(cwd, LIVESPEC_DIR)));
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The directories a command may run in after earlier `cd`s; over-approximates to
 * block more, never less. `root` is the project directory that holds `.pi/livespec/`.
 */
export class DirectoryCandidates {
	private dirs: string[];
	private unknown = false;

	constructor(private readonly root: string) {
		this.dirs = [root];
	}

	/** A copy for a child shell: what it inherits, without its `cd`s flowing back. */
	clone(): DirectoryCandidates {
		const copy = new DirectoryCandidates(this.root);
		copy.dirs = [...this.dirs];
		copy.unknown = this.unknown;
		return copy;
	}

	/** The first write target of `cmd` (whose effective words are `words`) under `.pi/livespec/`. */
	protectedTarget(cmd: ShellCommand, words: Word[]): string | undefined {
		const name = commandName(words[0]);
		const targets = [...redirectTargets(cmd), ...commandTargets(name, words.slice(1))];
		const removed = TREE_REMOVERS.has(name) ? removedTargets(name, words.slice(1)) : [];
		return (targets.find((t) => this.protects(t)) ?? removed.find((t) => this.containsLivespec(t)))?.text;
	}

	/** Applies a `cd`/`pushd` given by the effective words; other commands change nothing. */
	follow(words: Word[]): void {
		if (CD_COMMANDS.has(commandName(words[0]))) this.change(words.slice(1));
	}

	private change(args: Word[]): void {
		const arg = args.find((w) => !w.text.startsWith("-") || w.text === "-");
		if (!arg || arg.expansion || arg.text === "-" || arg.text.startsWith("~")) {
			this.unknown = true;
			return;
		}
		const next = this.dirs.map((d) => resolve(d, arg.text));
		this.dirs = [...new Set([...this.dirs, ...next])];
	}

	private protects(target: Word): boolean {
		const mentionsLivespec = target.text.includes("livespec");
		if (target.expansion) return mentionsLivespec;
		if (this.unknown && !isAbsolute(target.text) && mentionsLivespec) return true;
		return this.dirs.some((d) => isLivespecPath(this.root, resolve(d, target.text)));
	}

	/** A removed or moved target that holds `.pi/livespec`; an expansion or an unknown directory counts when it may. */
	private containsLivespec(target: Word): boolean {
		const mayHold = /(^|\/)\.pi(\/|$)|^\.{1,2}\/?$/.test(target.text);
		if (target.expansion) return mayHold;
		if (this.unknown && !isAbsolute(target.text) && mayHold) return true;
		return this.dirs.some((d) => isLivespecAncestor(this.root, resolve(d, target.text)));
	}
}

/** The paths `rm`/`rmdir` remove or `mv` moves away: every operand, but not `mv`'s destination. */
function removedTargets(name: string, args: Word[]): Word[] {
	const paths = operands(args, name === "mv" ? ["-t", "--target-directory", "-S", "--suffix"] : []);
	if (name !== "mv" || optionArgument(args, "-t", "--target-directory")) return paths;
	return paths.slice(0, -1);
}

function redirectTargets(cmd: ShellCommand): Word[] {
	return cmd.redirects.filter((r) => !READ_REDIRECTS.has(r.op.replace(/^\d/, "")) && !isDescriptorDup(r.op, r.target)).map((r) => r.target);
}

function isDescriptorDup(op: string, target: Word): boolean {
	return op.endsWith("&") && /^(\d+|-)$/.test(target.text);
}

function commandTargets(name: string, args: Word[]): Word[] {
	if (ALL_PATHS_WRITTEN.has(name)) return operands(args);
	if (LAST_PATH_WRITTEN.has(name)) return lastPathTargets(args);
	if (name === "sed") return sedTargets(args);
	if (name === "perl") return perlTargets(args);
	return [];
}

function lastPathTargets(args: Word[]): Word[] {
	const dir = optionArgument(args, "-t", "--target-directory");
	if (dir) return [dir];
	const paths = operands(args);
	return paths.length > 0 ? [paths[paths.length - 1] as Word] : [];
}

/** `sed -i` edits every file operand; the script is the first operand unless `-e`/`-f` gave it. */
function sedTargets(args: Word[]): Word[] {
	if (!args.some((w) => /^-[a-zA-Z]*i/.test(w.text) || w.text.startsWith("--in-place"))) return [];
	const hasScriptOption = args.some((w) => /^-[a-zA-Z]*[ef]$/.test(w.text) || /^--(expression|file)/.test(w.text));
	const files = operands(args, ["-e", "-f", "--expression", "--file"]);
	return hasScriptOption ? files : files.slice(1);
}

/** `perl -i` edits every file operand; the program is the first operand unless `-e`/`-E` gave it. */
function perlTargets(args: Word[]): Word[] {
	if (!args.some((w) => /^-[a-zA-Z]*i/.test(w.text))) return [];
	const hasProgram = args.some((w) => /^-[a-zA-Z]*[eE]$/.test(w.text));
	const files = operands(args, ["-e", "-E"]);
	return hasProgram ? files : files.slice(1);
}

/** Non-option words; the word after an option in `valued` (or a short cluster ending in one) is skipped. */
function operands(args: Word[], valued: string[] = []): Word[] {
	const out: Word[] = [];
	for (let k = 0; k < args.length; k++) {
		const w = args[k] as Word;
		if (w.text === "--") return [...out, ...args.slice(k + 1)];
		if (!w.text.startsWith("-") || w.text === "-") out.push(w);
		else if (valued.some((v) => isShort(v) && w.text.startsWith(v) && w.text.length > v.length && !/^-[a-zA-Z]+$/.test(w.text))) continue; // `-tDIR`: value attached
		else if (valued.some((v) => w.text === v || (!v.startsWith("--") && /^-[a-zA-Z]+$/.test(w.text) && w.text.endsWith(v.slice(1))))) k++;
	}
	return out;
}

const isShort = (v: string): boolean => !v.startsWith("--");

function optionArgument(args: Word[], short: string, long: string): Word | undefined {
	for (let k = 0; k < args.length; k++) {
		const w = args[k] as Word;
		if (w.text === short || w.text === long) return args[k + 1];
		if (w.text.startsWith(short) && !w.text.startsWith("--") && w.text.length > short.length) return { ...w, text: w.text.slice(short.length) };
		if (w.text.startsWith(`${long}=`)) return { ...w, text: w.text.slice(long.length + 1) };
	}
	return undefined;
}

/** `path` with its deepest existing ancestor replaced by that ancestor's real path. */
function realResolve(path: string): string {
	let existing = path;
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return path;
		existing = parent;
	}
	return join(realpathSync(existing), relative(existing, path));
}
