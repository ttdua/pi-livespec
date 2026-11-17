// The forge rule table (design D7): which unwrapped invocations of git, gh, tea,
// curl and wget push, open pull requests or write to the forge. Each rule names
// itself in its block reason.

import { hasOption, optionValues, type Scanned, scanOptions, set } from "./options.ts";
import type { Word } from "./shell.ts";

/** A command after wrappers and global options are removed; `args[0]` is the subcommand. */
export type Invocation = { name: string; args: Word[] };
export type Block = { allow: false; rule: string; reason: string };
type Rule = { id: string; matches: (inv: Invocation, endpoints: string[]) => boolean; explain: (inv: Invocation) => { what: string; advice: string } };

export const GUARD_PREFIX = "livespec guard:";
const PUSH_ADVICE = "pushes and pull requests happen only through livespec tools (LS-09), not from bash";
const FORGE_ADVICE = "use the livespec tools (spec_write, spec_question, spec_gate, unit_finish), or ask a human";

/** A block decision whose reason names `rule`, says what was blocked and what to do instead. */
export function blockFor(rule: string, what: string, advice: string): Block {
	return { allow: false, rule, reason: `${GUARD_PREFIX} ${what} (rule ${rule}); ${advice}.` };
}

export function pushBlock(): Block {
	return blockFor("push", "git push is blocked", PUSH_ADVICE);
}

/** The first forge rule `inv` matches, as a block decision. */
export function matchRule(inv: Invocation, endpoints: string[]): Block | undefined {
	const rule = RULES.find((r) => r.matches(inv, endpoints));
	if (!rule) return undefined;
	const { what, advice } = rule.explain(inv);
	return blockFor(rule.id, what, advice);
}

// ---------------------------------------------------------------- option tables

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
const CURL_URL = set("--url");
const CURL_BODY = set("-d", "--data*", "--json", "-F", "--form", "--form-string", "-T", "--upload-file");
const WGET_VALUED = set("-O", "--output-document", "-o", "--output-file", "--header", "--user", "--password", "-U", "--user-agent", "--method", "--post-data", "--post-file", "--body-data", "--body-file");
const WGET_METHOD = set("--method");
const WGET_BODY = set("--post-data", "--post-file", "--body-*");
const READ_METHODS = set("GET", "HEAD");

function ghScan(inv: Invocation): Scanned | undefined {
	return inv.name === "gh" ? scanOptions(inv.args, GH_VALUED, false) : undefined;
}

function ghOperands(inv: Invocation): string[] {
	return ghScan(inv)?.operands.map((w) => w.text) ?? [];
}

function teaOperands(inv: Invocation): string[] {
	return inv.name === "tea" ? scanOptions(inv.args, TEA_VALUED, false).operands.map((w) => w.text) : [];
}

/** The words that decide what a forge CLI or HTTP client does; an expansion there hides the operation. */
export function decisiveWords(inv: Invocation): Word[] {
	const gh = ghScan(inv);
	if (gh) return gh.operands[0]?.text === "api" ? [gh.operands[0], ...optionValues(gh, GH_API_METHOD)] : gh.operands.slice(0, 2);
	if (inv.name === "tea") return scanOptions(inv.args, TEA_VALUED, false).operands.slice(0, 2);
	if (inv.name === "curl") {
		const s = scanOptions(inv.args, CURL_VALUED, false);
		return [...s.operands, ...optionValues(s, CURL_METHOD), ...optionValues(s, CURL_URL)];
	}
	if (inv.name === "wget") {
		const s = scanOptions(inv.args, WGET_VALUED, false);
		return [...s.operands, ...optionValues(s, WGET_METHOD)];
	}
	return [];
}

// ---------------------------------------------------------------- gh and tea

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
const TEA_ISSUE_WRITES = set("create", "edit", "close", "reopen");
const TEA_LABEL_WRITES = set("create", "update", "delete");
const TEA_WRITES: Readonly<Record<string, ReadonlySet<string> | "all-but-list">> = {
	issues: TEA_ISSUE_WRITES,
	issue: TEA_ISSUE_WRITES,
	i: TEA_ISSUE_WRITES,
	labels: TEA_LABEL_WRITES,
	label: TEA_LABEL_WRITES,
	releases: "all-but-list",
	release: "all-but-list",
	r: "all-but-list",
};

function isGhIssueWrite(inv: Invocation): boolean {
	const [sub, action = ""] = ghOperands(inv);
	return sub === "issue" && GH_ISSUE_WRITES.has(action);
}

function isGhPrWrite(inv: Invocation): boolean {
	const [sub, action = ""] = ghOperands(inv);
	return sub === "pr" && GH_PR_WRITES.has(action);
}

function isTeaPr(inv: Invocation): boolean {
	const [sub = "", action = "list"] = teaOperands(inv);
	return TEA_PR.has(sub) && !TEA_READS.has(action);
}

function isGhApiWrite(inv: Invocation): boolean {
	const s = ghScan(inv);
	if (s?.operands[0]?.text !== "api") return false;
	const method = optionValues(s, GH_API_METHOD).at(-1)?.text.toUpperCase();
	return method !== undefined ? method !== "GET" : hasOption(s, GH_API_FIELDS);
}

const GH_ALIAS_WRITES = set("set", "import");
const SUBTREE_VALUED = set("-P", "--prefix", "-m", "--message");

/** `git push`, `git send-pack` and `git subtree … push`; `args[0]` is the subcommand. */
function isGitPush(inv: Invocation): boolean {
	if (inv.name !== "git") return false;
	const sub = inv.args[0]?.text;
	if (sub === "push" || sub === "send-pack") return true;
	return sub === "subtree" && scanOptions(inv.args.slice(1), SUBTREE_VALUED, false).operands[0]?.text === "push";
}

function isGhAliasWrite(inv: Invocation): boolean {
	const [sub, action = ""] = ghOperands(inv);
	return sub === "alias" && GH_ALIAS_WRITES.has(action);
}

function isGhOtherWrite(inv: Invocation): boolean {
	const [sub = "", action = ""] = ghOperands(inv);
	return GH_OTHER_WRITES[sub]?.has(action) ?? false;
}

function isTeaWrite(inv: Invocation): boolean {
	const [sub = "", action = ""] = teaOperands(inv);
	if (sub === "comment" || sub === "c") return true;
	const writes = TEA_WRITES[sub];
	if (writes === "all-but-list") return action !== "" && !TEA_READS.has(action);
	return writes?.has(action) ?? false;
}

// ---------------------------------------------------------------- HTTP

/** A request body or a non-read method sent to a forge endpoint; a body blocks whatever the method. */
function isHttpWrite(inv: Invocation, endpoints: string[]): boolean {
	if (inv.name !== "curl" && inv.name !== "wget") return false;
	const curl = inv.name === "curl";
	const s = scanOptions(inv.args, curl ? CURL_VALUED : WGET_VALUED, false);
	const urls = curl ? [...s.operands, ...optionValues(s, CURL_URL)] : s.operands;
	if (!urls.some((w) => isEndpoint(w.text, endpoints))) return false;
	if (hasOption(s, curl ? CURL_BODY : WGET_BODY)) return true;
	const method = optionValues(s, curl ? CURL_METHOD : WGET_METHOD).at(-1)?.text.toUpperCase();
	return method !== undefined && !READ_METHODS.has(method);
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

function isEndpoint(text: string, endpoints: string[]): boolean {
	const host = hostOf(text);
	if (!host) return false;
	const name = host.replace(/:\d+$/, "");
	return endpoints.some((ep) => ep === host || ep === name);
}

// ---------------------------------------------------------------- table

const forgeWrite = (what: string) => () => ({ what, advice: FORGE_ADVICE });

const RULES: readonly Rule[] = [
	{ id: "push", matches: isGitPush, explain: () => ({ what: "git push is blocked", advice: PUSH_ADVICE }) },
	{ id: "gh-alias", matches: isGhAliasWrite, explain: () => ({ what: "gh alias set and import are blocked because gh aliases can hide forge writes", advice: "run the gh command itself, or ask a human" }) },
	{
		id: "gh-issue",
		matches: isGhIssueWrite,
		explain: (inv) => {
			const action = ghOperands(inv)[1] ?? "";
			return { what: `gh issue ${action} writes to the forge`, advice: GH_ISSUE_TOOLS[action] ?? "only a human may do this" };
		},
	},
	{ id: "pull-request", matches: (inv) => isGhPrWrite(inv) || isTeaPr(inv), explain: () => ({ what: "pull request commands are blocked", advice: PUSH_ADVICE }) },
	{ id: "gh-api", matches: isGhApiWrite, explain: forgeWrite("gh api with a write method or fields writes to the forge") },
	{ id: "gh-write", matches: isGhOtherWrite, explain: forgeWrite("this gh command writes to the forge") },
	{ id: "tea-write", matches: isTeaWrite, explain: forgeWrite("this tea command writes to the forge") },
	{ id: "http-write", matches: isHttpWrite, explain: forgeWrite("this HTTP request writes to a forge endpoint") },
];
