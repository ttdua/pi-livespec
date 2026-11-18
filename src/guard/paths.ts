// Which paths are livespec project files, and which bash commands write them
// (design D7 "Working directory inside one command"). Resolving symlinks of
// existing parents is the only I/O.

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ShellCommand, Word } from "./shell.ts";
import { optionValues, type Scanned, scanOptions, set } from "./options.ts";
import { chdirValues, commandName, stripWrappers } from "./unwrap.ts";
import { hasUnknownOption, normalizeLongOptions } from "./writeoptions.ts";

const LIVESPEC_DIR = join(".pi", "livespec");
const CD_COMMANDS = new Set(["cd", "pushd"]);
/** Commands whose every path argument is written (or removed). */
const ALL_PATHS_WRITTEN = new Set(["tee", "rm", "touch", "mv", "rmdir"]);
/** Commands that remove or move their path arguments, so an ancestor of `.pi/livespec` is a protected target too. */
const TREE_REMOVERS = new Set(["rm", "mv", "rmdir"]);
/** Commands that write only their last path argument, or the `-t DIR` value. */
const LAST_PATH_WRITTEN = new Set(["cp", "ln", "install"]);
/** `-t DIR` / `--target-directory=DIR`: the one destination of cp, ln, install and mv. */
const TARGET_DIR = set("-t", "--target-directory");
const BACKUP_SUFFIX = ["-S", "--suffix"];
/** Options that take a value, per command; a missing command has none, so each non-option word counts as a path. */
const VALUED_OPTIONS: Record<string, ReadonlySet<string>> = {
	cp: set("-t", "--target-directory", ...BACKUP_SUFFIX),
	ln: set("-t", "--target-directory", ...BACKUP_SUFFIX),
	mv: set("-t", "--target-directory", ...BACKUP_SUFFIX),
	install: set("-t", "--target-directory", ...BACKUP_SUFFIX, "-m", "--mode", "-o", "--owner", "-g", "--group"),
	touch: set("-d", "--date", "-r", "--reference", "-t", "--time"),
	sed: set("-e", "-f", "--expression", "--file", "-l", "--line-length"),
	perl: set("-e", "-E", "-I"),
};
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
		// Redirects are opened by the outer shell; the wrapped command runs in the wrapper's directories.
		const redirected = redirectTargets(cmd).find((t) => this.protects(t));
		return (redirected ?? this.scoped(cmd.words).commandTarget(words))?.text;
	}

	private commandTarget(words: Word[]): Word | undefined {
		const name = commandName(words[0]);
		const args = words.slice(1);
		const removed = TREE_REMOVERS.has(name) ? removedTargets(name, args) : [];
		return commandTargets(name, args).find((t) => this.protects(t)) ?? removed.find((t) => this.containsLivespec(t)) ?? this.unmodelledOptionTarget(name, args);
	}

	/** The directories for the command a wrapper chain runs in `words` (`env -C`, `sudo -D`); this one when there is no chdir. `cd`s of the script are unaffected. */
	scoped(words: Word[]): DirectoryCandidates {
		const chdirs = chdirValues(words);
		if (chdirs.length === 0) return this;
		const copy = this.clone();
		for (const dir of chdirs) copy.enter(dir);
		return copy;
	}

	/** An argument that touches livespec when a write command carries an option this guard does not model. */
	private unmodelledOptionTarget(name: string, args: Word[]): Word | undefined {
		if (!hasUnmodelledOption(name, args)) return undefined;
		const scanned = scanCommand(name, args);
		const words = [...args, ...scanned.options.flatMap((o) => (o.value ? [o.value] : []))];
		// perl's unmodelled options include `-xDIR`, which changes the directory, so any `.pi` mention counts.
		const mentions = (w: Word) => w.text.includes("livespec") || (name === "perl" && w.text.includes(".pi"));
		return words.find((w) => mentions(w) || this.protects(w) || this.containsLivespec(w));
	}

	/** Applies a `cd`/`pushd` given by the effective words; other commands change nothing. */
	follow(words: Word[]): void {
		if (CD_COMMANDS.has(commandName(words[0]))) this.change(words.slice(1));
	}

	private change(args: Word[]): void {
		const arg = args.find((w) => !w.text.startsWith("-") || w.text === "-");
		this.enter(arg);
	}

	/** Moves into `arg`; a missing, expanded, `-` or `~` directory makes the directory unknown. */
	private enter(arg: Word | undefined): void {
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
	const scanned = scanCommand(name, args);
	if (name !== "mv" || optionValues(scanned, TARGET_DIR).length > 0) return scanned.operands;
	return scanned.operands.slice(0, -1);
}

function redirectTargets(cmd: ShellCommand): Word[] {
	return cmd.redirects.filter((r) => !READ_REDIRECTS.has(r.op.replace(/^\d/, "")) && !isDescriptorDup(r.op, r.target)).map((r) => r.target);
}

function isDescriptorDup(op: string, target: Word): boolean {
	return op.endsWith("&") && /^(\d+|-)$/.test(target.text);
}

function commandTargets(name: string, args: Word[]): Word[] {
	if (ALL_PATHS_WRITTEN.has(name)) {
		const scanned = scanCommand(name, args);
		return [...scanned.operands, ...optionValues(scanned, TARGET_DIR)];
	}
	if (LAST_PATH_WRITTEN.has(name)) return lastPathTargets(name, args);
	if (name === "sed") return sedTargets(args);
	if (name === "perl") return perlTargets(args);
	return [];
}

/** Scans `args` with the options of `name` that take a value; other commands treat every non-option word as an operand. */
function scanCommand(name: string, args: Word[]): Scanned {
	return scanOptions(normalizeLongOptions(name, args), VALUED_OPTIONS[name] ?? set(), false);
}

/** True for a write command (`sed`/`perl` only with `-i`) that carries an option outside its known list. */
function hasUnmodelledOption(name: string, args: Word[]): boolean {
	if (name === "sed") return inPlaceSed(args) && hasUnknownOption(name, scanSed(args));
	if (name === "perl") return inPlacePerl(args) && hasUnknownOption(name, scanPerl(args));
	if (!ALL_PATHS_WRITTEN.has(name) && !LAST_PATH_WRITTEN.has(name)) return false;
	return hasUnknownOption(name, scanCommand(name, args));
}

/** The `-t DIR` value when given (it is the only write target), else the last operand. */
function lastPathTargets(name: string, args: Word[]): Word[] {
	const scanned = scanCommand(name, args);
	const dirs = optionValues(scanned, TARGET_DIR);
	if (dirs.length > 0) return dirs;
	// `install -d` creates every operand as a directory.
	if (name === "install" && scanned.options.some((o) => o.name === "-d" || o.name === "--directory")) return scanned.operands;
	return scanned.operands.slice(-1);
}

function scanSed(args: Word[]): Scanned {
	return scanOptions(normalizeLongOptions("sed", args), VALUED_OPTIONS.sed as ReadonlySet<string>, false, set("-i"));
}

function inPlaceSed(args: Word[]): boolean {
	return scanSed(args).options.some((o) => o.name === "-i" || o.name === "--in-place");
}

/** `sed -i` edits every file operand; the script is the first operand unless `-e`/`-f` gave it. */
function sedTargets(args: Word[]): Word[] {
	const scanned = scanSed(args);
	if (!inPlaceSed(args)) return [];
	const hasScript = scanned.options.some((o) => ["-e", "-f", "--expression", "--file"].includes(o.name));
	return hasScript ? scanned.operands : scanned.operands.slice(1);
}

function scanPerl(args: Word[]): Scanned {
	return scanOptions(args, VALUED_OPTIONS.perl as ReadonlySet<string>, false, set("-i"));
}

function inPlacePerl(args: Word[]): boolean {
	return scanPerl(args).options.some((o) => o.name === "-i");
}

/** `perl -i` edits every file operand; the program is the first operand unless `-e`/`-E` gave it. */
function perlTargets(args: Word[]): Word[] {
	const scanned = scanPerl(args);
	if (!inPlacePerl(args)) return [];
	const hasProgram = scanned.options.some((o) => o.name === "-e" || o.name === "-E");
	return hasProgram ? scanned.operands : scanned.operands.slice(1);
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
