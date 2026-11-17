// The pure bash-command guard (design D7): it blocks forge writes, pushes, pull
// requests, obscured forms of those and writes into `.pi/livespec/`. A command
// is parsed, wrappers are unwrapped up to UNWRAP_DEPTH, and a rule table decides.

import type { ProjectConfig } from "../config.ts";
import type { ForgeKind } from "../forge/types.ts";
import { protectedWrite } from "./paths.ts";
import { parseShell, type ShellCommand, type Word } from "./shell.ts";

export const UNWRAP_DEPTH = 8;

export type GuardDecision = { allow: true } | { allow: false; rule: string; reason: string };
export type GuardContext = { cwd: string; endpoints: string[]; aliases: Record<string, string> | "unknown" };

/** A command after wrappers and global options are removed; `args[0]` is the subcommand. */
type Invocation = { name: string; args: Word[] };
type Rule = { id: string; matches: (inv: Invocation, ctx: GuardContext) => boolean; reason: (inv: Invocation) => string };
/** What a check needs besides the context: whether the whole command text holds a dangerous token. */
type Scan = { ctx: GuardContext; dangerous: boolean };

const ALLOW: GuardDecision = { allow: true };
const PREFIX = "livespec guard:";
const GITHUB_HOST = "github.com";
const PUSH_REASON = `${PREFIX} git push is blocked (rule push); pushes and pull requests happen only through livespec tools (LS-09), not from bash.`;
const PR_REASON = `${PREFIX} pull request commands are blocked (rule pull-request); pushes and pull requests happen only through livespec tools (LS-09).`;
const FORGE_REASON = `${PREFIX} this command writes to the forge (rule forge-write); use the livespec tools (spec_write, spec_question, spec_gate, unit_finish), or ask a human.`;
const OBSCURED_REASON = `${PREFIX} the command hides a push or forge write behind eval, a variable, a substitution or unreadable text (rule obscured); write it out plainly, or ask a human.`;

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

/** The host of a URL-like word (with or without a scheme), or undefined. */
function hostOf(text: string): string | undefined {
	const candidate = text.includes("://") ? text : /^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(text) ? `http://${text}` : undefined;
	if (!candidate) return undefined;
	try {
		return new URL(candidate).host.toLowerCase();
	} catch {
		return undefined;
	}
}

function isEndpoint(text: string, ctx: GuardContext): boolean {
	const host = hostOf(text);
	if (!host) return false;
	const name = host.replace(/:\d+$/, "");
	return ctx.endpoints.some((ep) => ep === host || ep === name);
}

// ---------------------------------------------------------------- entry

/** Decides whether the agent may run `command`. Pure apart from resolving symlinks of `.pi/livespec/` targets. */
export function classifyCommand(command: string, ctx: GuardContext): GuardDecision {
	return checkScript(command, { ctx, dangerous: hasDangerousToken(command, ctx.endpoints) }, 0);
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
	return scan.dangerous ? { allow: false, rule: "obscured", reason: OBSCURED_REASON } : ALLOW;
}

function checkScript(text: string, scan: Scan, depth: number): GuardDecision {
	if (depth > UNWRAP_DEPTH) return obscured(scan);
	const commands = parseShell(text);
	if (commands === "unreadable") return obscured(scan);
	const target = protectedWrite(commands, scan.ctx.cwd);
	if (target !== undefined) return livespecBlock(target);
	return firstBlock(commands.map((cmd) => () => checkCommand(cmd, scan, depth)));
}

function livespecBlock(target: string): GuardDecision {
	return { allow: false, rule: "livespec-files", reason: `${PREFIX} ${target} is under .pi/livespec/ (rule livespec-files); the project flow and config are changed by a human only.` };
}

/** Runs checks lazily in order; the first block wins. */
function firstBlock(checks: (() => GuardDecision)[]): GuardDecision {
	for (const check of checks) {
		const d = check();
		if (!d.allow) return d;
	}
	return ALLOW;
}

function checkCommand(cmd: ShellCommand, scan: Scan, depth: number): GuardDecision {
	return firstBlock([...cmd.substitutions.map((sub) => () => checkScript(sub, scan, depth + 1)), () => checkWords(cmd.words, scan, depth)]);
}

function checkWords(words: Word[], scan: Scan, depth: number): GuardDecision {
	const unwrapped = stripWrappers(words);
	if (unwrapped === "too-deep") return obscured(scan);
	const head = unwrapped[0];
	if (!head) return ALLOW;
	if (head.expansion) return obscured(scan);
	const name = commandName(head);
	const args = unwrapped.slice(1);
	if (name === "eval") return checkEval(args, scan, depth);
	if (name === "source" || name === ".") return args.some((w) => w.expansion) ? obscured(scan) : ALLOW;
	if (SHELLS.has(name)) return checkShell(args, scan, depth);
	if (name === "git") return checkGit(args, scan, depth);
	return checkInvocation({ name, args }, scan);
}

function commandName(w: Word): string {
	const text = w.text.replace(/^\\/, "");
	return text.slice(text.lastIndexOf("/") + 1);
}

/** Literal `eval` text is checked as a script; an expanded one is obscured when the command is dangerous. */
function checkEval(args: Word[], scan: Scan, depth: number): GuardDecision {
	if (args.some((w) => w.expansion)) return obscured(scan);
	return checkScript(args.map((w) => w.text).join(" "), scan, depth + 1);
}

// ---------------------------------------------------------------- options

type Option = { name: string; value?: Word };
type Scanned = { options: Option[]; operands: Word[] };

/**
 * Splits arguments into options and operands. `valued` options take a value
 * (attached or the next word). With `stopAtOperand`, everything from the first
 * operand on is an operand, as for wrappers and global options.
 */
function scanOptions(args: Word[], valued: ReadonlySet<string>, stopAtOperand: boolean): Scanned {
	const options: Option[] = [];
	const operands: Word[] = [];
	for (let k = 0; k < args.length; k++) {
		const w = args[k] as Word;
		if (w.text === "--") {
			operands.push(...args.slice(k + 1));
			break;
		}
		if (!w.text.startsWith("-") || w.text === "-") {
			if (stopAtOperand) {
				operands.push(...args.slice(k));
				break;
			}
			operands.push(w);
			continue;
		}
		const taken = w.text.startsWith("--") ? readLong(w, args[k + 1], valued, options) : readShort(w, args[k + 1], valued, options);
		k += taken;
	}
	return { options, operands };
}

/** Records one long option; returns 1 when it consumed the next word. */
function readLong(w: Word, next: Word | undefined, valued: ReadonlySet<string>, out: Option[]): number {
	const eq = w.text.indexOf("=");
	if (eq > 0) {
		out.push({ name: w.text.slice(0, eq), value: { ...w, text: w.text.slice(eq + 1) } });
		return 0;
	}
	if (!valued.has(w.text)) {
		out.push({ name: w.text });
		return 0;
	}
	out.push(next ? { name: w.text, value: next } : { name: w.text });
	return next ? 1 : 0;
}

/** Records a short cluster such as `-sXPOST`; returns 1 when it consumed the next word. */
function readShort(w: Word, next: Word | undefined, valued: ReadonlySet<string>, out: Option[]): number {
	for (let j = 1; j < w.text.length; j++) {
		const name = `-${w.text[j]}`;
		if (!valued.has(name)) {
			out.push({ name });
			continue;
		}
		const rest = w.text.slice(j + 1);
		if (rest !== "") {
			out.push({ name, value: { ...w, text: rest } });
			return 0;
		}
		out.push(next ? { name, value: next } : { name });
		return next ? 1 : 0;
	}
	return 0;
}

function optionValues(scanned: Scanned, names: ReadonlySet<string>): Word[] {
	return scanned.options.filter((o) => names.has(o.name) && o.value).map((o) => o.value as Word);
}

function hasOption(scanned: Scanned, names: ReadonlySet<string>): boolean {
	return scanned.options.some((o) => names.has(o.name) || [...names].some((n) => n.endsWith("*") && o.name.startsWith(n.slice(0, -1))));
}

// ---------------------------------------------------------------- unwrapping

type Wrapper = { valued: ReadonlySet<string>; skipOperands?: (operands: Word[]) => number };

const set = (...names: string[]): ReadonlySet<string> => new Set(names);
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

function countWhile(words: Word[], pred: (w: Word) => boolean): number {
	const index = words.findIndex((w) => !pred(w));
	return index < 0 ? words.length : index;
}

/** Removes wrapper commands such as `env`, `sudo` or `xargs`; "too-deep" when wrappers nest beyond UNWRAP_DEPTH. */
function stripWrappers(words: Word[]): Word[] | "too-deep" {
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

const SHELLS = set("sh", "bash", "zsh", "dash");
const SHELL_VALUED = set("-o", "-O", "--rcfile", "--init-file");

/** `sh -c <script>` reparses the script; a script file is allowed (accepted limit); stdin is unseen. */
function checkShell(args: Word[], scan: Scan, depth: number): GuardDecision {
	const scanned = scanOptions(args, SHELL_VALUED, true);
	const names = new Set(scanned.options.map((o) => o.name));
	const first = scanned.operands[0];
	if (names.has("-c")) {
		if (!first) return ALLOW;
		return first.expansion ? obscured(scan) : checkScript(first.text, scan, depth + 1);
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

function checkGit(args: Word[], scan: Scan, depth: number): GuardDecision {
	if (depth > UNWRAP_DEPTH) return obscured(scan);
	const global = scanOptions(args, GIT_GLOBAL_VALUED, true);
	const rest = global.operands;
	const sub = rest[0];
	if (!sub) return ALLOW;
	if (sub.expansion) return obscured(scan);
	if (GIT_BUILTINS.has(sub.text)) return checkInvocation({ name: "git", args: rest }, scan);
	const configured = scan.ctx.aliases;
	const alias = inlineAliases(global)[sub.text] ?? (configured === "unknown" ? undefined : configured[sub.text]);
	if (alias === undefined && configured === "unknown") return mentionsPush(rest.map((w) => w.text).join(" ")) ? pushBlock() : ALLOW;
	return alias === undefined ? ALLOW : checkGitAlias(alias, rest.slice(1), scan, depth);
}

/** Aliases defined for this invocation with `git -c alias.<name>=<value>`. */
function inlineAliases(global: Scanned): Record<string, string> {
	const entries = optionValues(global, set("-c"))
		.map((w) => /^alias\.([^=]+)=(.*)$/is.exec(w.text))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => [m[1] as string, m[2] as string] as const);
	return Object.fromEntries(entries);
}

/** A `!` alias is a shell script; any other alias is more git arguments. */
function checkGitAlias(alias: string, rest: Word[], scan: Scan, depth: number): GuardDecision {
	if (alias.startsWith("!")) return mentionsPush(alias) ? pushBlock() : checkScript(alias.slice(1), scan, depth + 1);
	const parsed = parseShell(alias);
	if (parsed === "unreadable") return mentionsPush(alias) ? pushBlock() : ALLOW;
	return checkGit([...(parsed[0]?.words ?? []), ...rest], scan, depth + 1);
}

function mentionsPush(text: string): boolean {
	return /(^|[^\w-])push($|[^\w-])/i.test(text);
}

function pushBlock(): GuardDecision {
	return { allow: false, rule: "push", reason: PUSH_REASON };
}

// ---------------------------------------------------------------- forge CLIs and HTTP

const GH_VALUED = set("-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--title", "-X", "--method", "-f", "--field", "--raw-field", "--input", "-H", "--header", "-q", "--jq");
const GH_API_METHOD = set("-X", "--method");
const GH_API_FIELDS = set("-f", "-F", "--field", "--raw-field", "--input");
const TEA_VALUED = set("-l", "--login", "-r", "--repo", "-R", "--remote", "-o", "--output");
const CURL_VALUED = set(
	...["-H", "--header", "-o", "--output", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "-w", "--write-out"],
	...["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "-F", "--form", "--form-string", "-T", "--upload-file"],
	...["-X", "--request", "-m", "--max-time", "--connect-timeout", "--retry", "-x", "--proxy", "--cacert", "--cert", "--key", "-K", "--config", "-r", "--range", "--url"],
);
const CURL_METHOD = set("-X", "--request");
const CURL_BODY = set("-d", "--data*", "--json", "-F", "--form", "--form-string", "-T", "--upload-file");
const CURL_GET = set("-G", "--get", "-I", "--head");
const WGET_VALUED = set("-O", "--output-document", "-o", "--output-file", "--header", "--user", "--password", "-U", "--user-agent", "--method", "--post-data", "--post-file", "--body-data", "--body-file");
const WGET_METHOD = set("--method");
const WGET_BODY = set("--post-data", "--post-file", "--body-*");
const READ_METHODS = set("GET", "HEAD");

/** The words that decide what a forge CLI or HTTP client does; an expansion there hides the operation. */
function decisiveWords(inv: Invocation): Word[] {
	if (inv.name === "gh") {
		const ops = scanOptions(inv.args, GH_VALUED, false);
		return ops.operands[0]?.text === "api" ? [ops.operands[0], ...optionValues(ops, GH_API_METHOD)] : ops.operands.slice(0, 2);
	}
	if (inv.name === "tea") return scanOptions(inv.args, TEA_VALUED, false).operands.slice(0, 2);
	if (inv.name === "curl") return httpDecisive(scanOptions(inv.args, CURL_VALUED, false), CURL_METHOD, "--url");
	if (inv.name === "wget") return httpDecisive(scanOptions(inv.args, WGET_VALUED, false), WGET_METHOD, undefined);
	return [];
}

function httpDecisive(s: Scanned, method: ReadonlySet<string>, urlOption: string | undefined): Word[] {
	return [...s.operands, ...optionValues(s, method), ...(urlOption ? optionValues(s, set(urlOption)) : [])];
}

function checkInvocation(inv: Invocation, scan: Scan): GuardDecision {
	if (decisiveWords(inv).some((w) => w.expansion)) return obscured(scan);
	const rule = RULES.find((r) => r.matches(inv, scan.ctx));
	return rule ? { allow: false, rule: rule.id, reason: rule.reason(inv) } : ALLOW;
}

function ghOperands(inv: Invocation): string[] {
	return inv.name === "gh" ? scanOptions(inv.args, GH_VALUED, false).operands.map((w) => w.text) : [];
}

function teaOperands(inv: Invocation): string[] {
	return inv.name === "tea" ? scanOptions(inv.args, TEA_VALUED, false).operands.map((w) => w.text) : [];
}

const GH_ISSUE_TOOLS: Readonly<Record<string, string>> = {
	edit: "use spec_write to change the issue body, or unit_finish to tick a unit",
	comment: "use spec_question or spec_gate to talk on the issue",
	create: "use change_new to open a change",
	close: "use spec_gate to finish a phase",
	reopen: "use spec_gate to resume a phase",
};
const GH_ISSUE_WRITES = set("create", "edit", "comment", "close", "reopen", "delete", "transfer", "lock", "unlock", "pin", "unpin");
const GH_PR_WRITES = set("create", "edit", "merge", "comment", "review", "close", "reopen", "ready");
const GH_OTHER_WRITES: Readonly<Record<string, ReadonlySet<string>>> = {
	label: set("create", "edit", "delete", "clone"),
	release: set("create", "edit", "delete", "delete-asset", "upload"),
	repo: set("create", "edit", "delete", "archive", "unarchive", "rename", "fork", "sync", "deploy-key"),
	secret: set("set", "delete", "remove"),
	variable: set("set", "delete"),
};
const TEA_PR = set("pr", "pull", "pulls");
const TEA_READS = set("list", "ls");
const TEA_WRITES: Readonly<Record<string, ReadonlySet<string> | "all-but-list">> = {
	issues: set("create", "edit", "close", "reopen"),
	issue: set("create", "edit", "close", "reopen"),
	i: set("create", "edit", "close", "reopen"),
	labels: set("create", "update", "delete"),
	label: set("create", "update", "delete"),
	releases: "all-but-list",
	release: "all-but-list",
	r: "all-but-list",
};

function ghIssueReason(inv: Invocation): string {
	const action = ghOperands(inv)[1] ?? "";
	const tool = GH_ISSUE_TOOLS[action] ?? "only a human may do this";
	return `${PREFIX} gh issue ${action} writes to the forge (rule gh-issue); ${tool}.`;
}

function isGhApiWrite(inv: Invocation): boolean {
	const s = scanOptions(inv.args, GH_VALUED, false);
	if (s.operands[0]?.text !== "api") return false;
	const method = optionValues(s, GH_API_METHOD).at(-1)?.text.toUpperCase();
	return method !== undefined ? method !== "GET" : hasOption(s, GH_API_FIELDS);
}

function isTeaWrite(inv: Invocation): boolean {
	const [sub = "", action = ""] = teaOperands(inv);
	if (sub === "comment" || sub === "c") return true;
	const writes = TEA_WRITES[sub];
	if (writes === "all-but-list") return action !== "" && !TEA_READS.has(action);
	return writes?.has(action) ?? false;
}

function isHttpWrite(inv: Invocation, ctx: GuardContext): boolean {
	if (inv.name !== "curl" && inv.name !== "wget") return false;
	const curl = inv.name === "curl";
	const s = scanOptions(inv.args, curl ? CURL_VALUED : WGET_VALUED, false);
	const urls = curl ? [...s.operands, ...optionValues(s, set("--url"))] : s.operands;
	if (!urls.some((w) => isEndpoint(w.text, ctx))) return false;
	const method = optionValues(s, curl ? CURL_METHOD : WGET_METHOD).at(-1)?.text.toUpperCase();
	if (method !== undefined) return !READ_METHODS.has(method);
	return hasOption(s, curl ? CURL_BODY : WGET_BODY) && !(curl && hasOption(s, CURL_GET));
}

const RULES: readonly Rule[] = [
	{ id: "push", matches: (inv) => inv.name === "git" && inv.args[0]?.text === "push", reason: () => PUSH_REASON },
	{ id: "gh-issue", matches: (inv) => ghOperands(inv)[0] === "issue" && GH_ISSUE_WRITES.has(ghOperands(inv)[1] ?? ""), reason: ghIssueReason },
	{ id: "pull-request", matches: (inv) => ghOperands(inv)[0] === "pr" && GH_PR_WRITES.has(ghOperands(inv)[1] ?? ""), reason: () => PR_REASON },
	{ id: "pull-request", matches: (inv) => TEA_PR.has(teaOperands(inv)[0] ?? "") && !TEA_READS.has(teaOperands(inv)[1] ?? "list"), reason: () => PR_REASON },
	{ id: "gh-api", matches: isGhApiWrite, reason: () => FORGE_REASON },
	{ id: "gh-write", matches: (inv) => GH_OTHER_WRITES[ghOperands(inv)[0] ?? ""]?.has(ghOperands(inv)[1] ?? "") ?? false, reason: () => FORGE_REASON },
	{ id: "tea-write", matches: isTeaWrite, reason: () => FORGE_REASON },
	{ id: "http-write", matches: isHttpWrite, reason: () => FORGE_REASON },
];
