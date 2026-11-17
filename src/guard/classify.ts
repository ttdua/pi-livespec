// The pure bash-command guard (design D7): it blocks forge writes, pushes, pull
// requests, obscured forms of those and writes into `.pi/livespec/`. A script
// is walked in source order with the candidate working directories; wrappers,
// nested shells, `eval` and substitutions are unwrapped up to UNWRAP_DEPTH.

import type { ProjectConfig } from "../config.ts";
import type { ForgeKind } from "../forge/types.ts";
import { optionValues, type Scanned, scanOptions, set } from "./options.ts";
import { DirectoryCandidates, effectiveWords } from "./paths.ts";
import { type Block, blockFor, decisiveWords, matchRule, pushBlock } from "./rules.ts";
import { parseShell, type ShellCommand, type Word } from "./shell.ts";
import { commandName, stripWrappers, UNWRAP_DEPTH } from "./unwrap.ts";

export { UNWRAP_DEPTH };

export type GuardDecision = { allow: true } | Block;
export type GuardContext = { cwd: string; endpoints: string[]; aliases: Record<string, string> | "unknown" };

/** What every check needs: the context and whether the whole command text holds a dangerous token. */
type Scan = { ctx: GuardContext; dangerous: boolean };

const ALLOW: GuardDecision = { allow: true };
const GITHUB_HOST = "github.com";

// ---------------------------------------------------------------- endpoints

/** The forge hosts a raw HTTP write must not reach, lowercased, without default ports, deduplicated. */
export function forgeEndpoints(target: { kind: ForgeKind; host: string; authority?: string } | undefined, config: ProjectConfig | null): string[] {
	const base = target ? targetHosts(target) : [GITHUB_HOST, `api.${GITHUB_HOST}`];
	const configured = [...(config?.githubHosts ?? []), ...(config?.giteaUrl ? [urlAuthority(config.giteaUrl)] : [])];
	return [...new Set([...base, ...configured].map(normalizeHost).filter((h) => h !== ""))];
}

function targetHosts(t: { kind: ForgeKind; host: string; authority?: string }): string[] {
	const hosts = [t.host, ...(t.authority ? [t.authority] : [])];
	return t.kind === "github" ? [...hosts, `api.${t.host}`, `uploads.${t.host}`] : hosts;
}

function urlAuthority(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/:(80|443)$/, "");
}

// ---------------------------------------------------------------- entry

/** Decides whether the agent may run `command`. Pure apart from resolving symlinks of `.pi/livespec/` targets. */
export function classifyCommand(command: string, ctx: GuardContext): GuardDecision {
	const scan: Scan = { ctx, dangerous: hasDangerousToken(command, ctx.endpoints) };
	return checkScript(command, scan, new DirectoryCandidates(ctx.cwd), 0);
}

/** `push`, `gh`, `tea` or a forge endpoint as a whole word, ignoring case and quotes. */
function hasDangerousToken(text: string, endpoints: string[]): boolean {
	const plain = text.replace(/['"\\]/g, "");
	return ["push", "gh", "tea", ...endpoints].some((token) => new RegExp(`(^|[^\\w.-])${escapeRegExp(token)}($|[^\\w-])`, "i").test(plain));
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function obscured(scan: Scan): GuardDecision {
	return scan.dangerous ? blockFor("obscured", "the command hides its operation behind eval, a variable, a substitution or unreadable text", "write it out plainly, or ask a human") : ALLOW;
}

/** Runs checks lazily in order; the first block wins. */
function firstBlock(checks: (() => GuardDecision)[]): GuardDecision {
	for (const check of checks) {
		const d = check();
		if (!d.allow) return d;
	}
	return ALLOW;
}

/** Checks a script in source order; `dirs` is updated by its `cd`s, as the shell running it would be. */
function checkScript(text: string, scan: Scan, dirs: DirectoryCandidates, depth: number): GuardDecision {
	if (depth > UNWRAP_DEPTH) return obscured(scan);
	const commands = parseShell(text);
	if (commands === "unreadable") return obscured(scan);
	for (const cmd of commands) {
		const d = checkCommand(cmd, scan, dirs, depth);
		if (!d.allow) return d;
		dirs.follow(effectiveWords(cmd));
	}
	return ALLOW;
}

/** Substitutions run in a child shell first, then the write targets and the command itself are checked. */
function checkCommand(cmd: ShellCommand, scan: Scan, dirs: DirectoryCandidates, depth: number): GuardDecision {
	return firstBlock([
		...cmd.substitutions.map((sub) => () => checkScript(sub, scan, dirs.clone(), depth + 1)),
		() => livespecWrite(cmd, dirs),
		() => checkWords(cmd.words, scan, dirs, depth),
	]);
}

function livespecWrite(cmd: ShellCommand, dirs: DirectoryCandidates): GuardDecision {
	const target = dirs.protectedTarget(cmd, effectiveWords(cmd));
	return target === undefined ? ALLOW : blockFor("livespec-files", `${target} is under .pi/livespec/`, "the project flow and config are changed by a human only");
}

function checkWords(words: Word[], scan: Scan, dirs: DirectoryCandidates, depth: number): GuardDecision {
	const unwrapped = stripWrappers(words);
	if (unwrapped === "too-deep") return obscured(scan);
	const head = unwrapped[0];
	if (!head) return ALLOW;
	if (head.expansion) return obscured(scan);
	const name = commandName(head);
	const args = unwrapped.slice(1);
	if (name === "eval") return checkEval(args, scan, dirs, depth);
	if (name === "source" || name === ".") return args.some((w) => w.expansion) ? obscured(scan) : ALLOW;
	if (SHELLS.has(name)) return checkShell(args, scan, dirs, depth);
	if (name === "git") return checkGit(args, scan, dirs, depth);
	return checkInvocation(name, args, scan);
}

/** `eval` of a dangerous command is obscured outright; other literal text is checked as a script in the same shell. */
function checkEval(args: Word[], scan: Scan, dirs: DirectoryCandidates, depth: number): GuardDecision {
	if (scan.dangerous) return obscured(scan);
	if (args.some((w) => w.expansion)) return ALLOW;
	return checkScript(args.map((w) => w.text).join(" "), scan, dirs, depth + 1);
}

function checkInvocation(name: string, args: Word[], scan: Scan): GuardDecision {
	const inv = { name, args };
	if (decisiveWords(inv).some((w) => w.expansion)) return obscured(scan);
	return matchRule(inv, scan.ctx.endpoints) ?? ALLOW;
}

// ---------------------------------------------------------------- nested shells

const SHELLS = set("sh", "bash", "zsh", "dash");
const SHELL_VALUED = set("-o", "-O", "--rcfile", "--init-file");

/** `sh -c <script>` checks the script in a child shell; a script file is allowed (accepted limit); stdin is unseen. */
function checkShell(args: Word[], scan: Scan, dirs: DirectoryCandidates, depth: number): GuardDecision {
	const scanned = scanOptions(args, SHELL_VALUED, true);
	const names = new Set(scanned.options.map((o) => o.name));
	const first = scanned.operands[0];
	if (names.has("-c")) {
		if (!first) return ALLOW;
		return first.expansion ? obscured(scan) : checkScript(first.text, scan, dirs.clone(), depth + 1);
	}
	return first && !names.has("-s") ? ALLOW : obscured(scan);
}

// ---------------------------------------------------------------- git

const GIT_GLOBAL_VALUED = set("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--list-cmds");
/** Built-in git commands; git ignores aliases that shadow them. */
const GIT_BUILTINS = set(
	...["add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch", "bundle", "cat-file", "check-attr", "check-ignore", "checkout", "cherry", "cherry-pick"],
	...["clean", "clone", "commit", "config", "count-objects", "describe", "diff", "diff-files", "diff-index", "diff-tree", "difftool", "fetch", "for-each-ref", "format-patch"],
	...["fsck", "gc", "grep", "hash-object", "help", "init", "log", "ls-files", "ls-remote", "ls-tree", "merge", "merge-base", "mergetool", "mv", "notes", "prune", "pull", "push"],
	...["range-diff", "rebase", "reflog", "remote", "repack", "replace", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-ref", "sparse-checkout"],
	...["stash", "status", "submodule", "switch", "symbolic-ref", "tag", "update-index", "update-ref", "var", "verify-commit", "version", "whatchanged", "worktree", "write-tree"],
);

function checkGit(args: Word[], scan: Scan, dirs: DirectoryCandidates, depth: number): GuardDecision {
	if (depth > UNWRAP_DEPTH) return obscured(scan);
	const global = scanOptions(args, GIT_GLOBAL_VALUED, true);
	const rest = global.operands;
	const sub = rest[0];
	if (!sub) return ALLOW;
	if (sub.expansion) return obscured(scan);
	if (GIT_BUILTINS.has(sub.text)) return checkInvocation("git", rest, scan);
	const configured = scan.ctx.aliases;
	const alias = inlineAliases(global)[sub.text] ?? (configured === "unknown" ? undefined : configured[sub.text]);
	if (alias === undefined && configured === "unknown") return mentionsPush(rest.map((w) => w.text).join(" ")) ? pushBlock() : ALLOW;
	return alias === undefined ? ALLOW : checkGitAlias(alias, rest.slice(1), scan, dirs, depth);
}

/** Aliases defined for this invocation with `git -c alias.<name>=<value>`. */
function inlineAliases(global: Scanned): Record<string, string> {
	const entries = optionValues(global, set("-c"))
		.map((w) => /^alias\.([^=]+)=(.*)$/is.exec(w.text))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => [m[1] as string, m[2] as string] as const);
	return Object.fromEntries(entries);
}

/** A `!` alias is a shell script run by git in a child shell; any other alias is more git arguments. */
function checkGitAlias(alias: string, rest: Word[], scan: Scan, dirs: DirectoryCandidates, depth: number): GuardDecision {
	if (alias.startsWith("!")) return mentionsPush(alias) ? pushBlock() : checkScript(alias.slice(1), scan, dirs.clone(), depth + 1);
	const parsed = parseShell(alias);
	if (parsed === "unreadable") return mentionsPush(alias) ? pushBlock() : ALLOW;
	return checkGit([...(parsed[0]?.words ?? []), ...rest], scan, dirs, depth + 1);
}

function mentionsPush(text: string): boolean {
	return /(^|[^\w-])push($|[^\w-])/i.test(text);
}
