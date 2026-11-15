// Account resolution for one forge target: gathers the facts (environment
// token, stored account, candidates and their access), lets the pure
// `selectAccount` decide, then performs the side effects of that decision:
// asking once, storing, and building the notice or the block. Every message is
// passed through `redactTokens`. Identity (`whoami`) is confirmed by the session.

import type { ForgeTarget } from "../forge/detect.ts";
import { tokenEnvVar } from "../forge/github.ts";
import { messageOf } from "../core/messages.ts";
import { ACCESS_TIMEOUT_MS, checkAccess, checkAll } from "./access.ts";
import { listCandidates } from "./candidates.ts";
import { redactTokens } from "./redact.ts";
import { selectAccount } from "./select.ts";
import { isSafeAccountName, readStored, writeStored } from "./store.ts";
import { candidateToken } from "./token.ts";
import type { Access, AccountCandidate, AccountEnv, AccountSource, SelectionFacts, SelectionResult, StoredAccount } from "./types.ts";

/** The outcome of a resolution: the account to connect with, or the block that refuses writes. Never holds a token in `facts`. */
export interface ResolvedAccount {
	/** Where the account comes from; unset when the resolution refused. */
	source?: AccountSource;
	account?: string;
	/** The forge user the account authenticates as; for `env`, set by the session from `whoami`. */
	user?: string;
	token?: string;
	unverified: boolean;
	/** Why writes are refused; set exactly when no account can be used. */
	block?: string;
	/** One line announcing a stored choice; set only when the git config was written. */
	notice?: string;
	facts: SelectionFacts;
}

/** The part of `ctx.ui` the question needs. */
export interface AccountUI {
	hasUI: boolean;
	select?(title: string, options: string[]): Promise<string | undefined>;
}

export type ChooseResult = { ok: true; resolved: ResolvedAccount } | { ok: false; message: string };

const SWITCH_COMMAND = "/livespec account <name>";
const QUESTION_TITLE = "Which account should livespec use for this repository?";
const NOTICE_WHY: Readonly<Record<"auto" | "asked", string>> = { auto: "chosen automatically", asked: "you chose it" };

/** The environment variable whose token decides the account for `target`. */
export function envTokenVar(target: ForgeTarget): "GH_TOKEN" | "GH_ENTERPRISE_TOKEN" | "GITEA_TOKEN" {
	return target.kind === "github" ? tokenEnvVar(target.authority) : "GITEA_TOKEN";
}

/** `<host>/<owner>/<repo>` of the target, as stored in `livespec.accountRemote`. */
export function remoteOf(target: ForgeTarget): string {
	return `${target.authority}/${target.owner}/${target.repo}`;
}

/** Everything one resolution works with; `tokens` collects every token seen, for redaction. */
interface Run {
	target: ForgeTarget;
	root: string;
	env: AccountEnv;
	tokens: string[];
	/** Why discovery found no candidates, for the refusal. */
	noCandidates?: string;
}

/**
 * Resolves the account of `target` for the clone at `root`. Never rejects: a
 * failure becomes a `block`. Writes the git config only for a `store` or an
 * answered `ask` result.
 */
export async function resolveAccount(target: ForgeTarget, root: string, ui: AccountUI, env: AccountEnv): Promise<ResolvedAccount> {
	const run: Run = { target, root, env, tokens: [] };
	const envToken = env.env[envTokenVar(target)] || undefined;
	if (envToken) run.tokens.push(envToken);
	let facts = baseFacts(target, envToken !== undefined, ui);
	try {
		facts = await gatherFacts(run, facts);
		return await apply(run, facts, selectAccount(facts), ui, envToken);
	} catch (error) {
		return blocked(run, facts, `account selection failed: ${messageOf(error)}`);
	}
}

function baseFacts(target: ForgeTarget, envToken: boolean, ui: AccountUI): SelectionFacts {
	return { forge: target.kind, envToken, remote: remoteOf(target), candidates: [], hasUI: ui.hasUI && ui.select !== undefined };
}

/** Reads the stored account and, without an environment token, the candidates with their access. */
async function gatherFacts(run: Run, facts: SelectionFacts): Promise<SelectionFacts> {
	const stored = await readStored(run.env.git, run.root);
	const withStored = stored ? { ...facts, stored } : facts;
	if (facts.envToken) return withStored;
	const list = await listCandidates(run.env, run.target);
	run.noCandidates = list.reason;
	return { ...withStored, candidates: await accessOf(run, list.candidates, stored, facts.forge) };
}

/**
 * The access of each candidate. When the stored account matches the remote and is a candidate, it is
 * checked alone first; if it can push, the stored rule decides and the others stay `unknown` unchecked.
 */
async function accessOf(
	run: Run,
	candidates: AccountCandidate[],
	stored: StoredAccount | undefined,
	forge: SelectionFacts["forge"],
): Promise<SelectionFacts["candidates"]> {
	const reusable = stored && stored.remote === remoteOf(run.target) && isSafeAccountName(stored.account, forge);
	const own = reusable ? candidates.find((c) => c.name === stored.account) : undefined;
	if (!own) return checkAll(run.env, run.target, candidates);
	const ownAccess = await checkAccess(run.env, run.target, own);
	// The stored rule decides: the other candidates stay unchecked.
	if (ownAccess === "true") return candidates.map((candidate) => ({ candidate, access: (candidate === own ? "true" : "unknown") as Access }));
	const others = new Map((await checkAll(run.env, run.target, candidates.filter((c) => c !== own))).map((e) => [e.candidate, e.access]));
	return candidates.map((candidate) => ({ candidate, access: candidate === own ? ownAccess : (others.get(candidate) ?? "unknown") }));
}

async function apply(run: Run, facts: SelectionFacts, result: SelectionResult, ui: AccountUI, envToken: string | undefined): Promise<ResolvedAccount> {
	switch (result.kind) {
		case "env":
			return { source: "env", token: envToken, unverified: false, facts };
		case "use":
			return useAccount(run, facts, result.account, "stored", result.unverified);
		case "store":
			return storeAccount(run, facts, result.account, "auto");
		case "ask":
			return askAccount(run, facts, result.options, ui);
		case "refuse":
			return blocked(run, facts, refusalMessage(run, facts, result));
	}
}

/** Asks once; a cancel, an unknown answer or a failing UI refuses exactly like the no-UI case. */
async function askAccount(run: Run, facts: SelectionFacts, options: string[], ui: AccountUI): Promise<ResolvedAccount> {
	const labels = options.map((name) => `${name} (${candidateOf(facts, name)?.user ?? ""}) — can push`);
	let answer: string | undefined;
	try {
		answer = await ui.select?.(QUESTION_TITLE, labels);
	} catch {
		// The UI disappeared mid-question: treated as a cancel.
		answer = undefined;
	}
	const index = answer === undefined ? -1 : labels.indexOf(answer);
	if (index === -1) return blocked(run, facts, ambiguousMessage(facts, options));
	return storeAccount(run, facts, options[index] as string, "asked");
}

/** Stores `name` for the remote (token first, so nothing is stored for an account without one) and announces it. */
async function storeAccount(run: Run, facts: SelectionFacts, name: string, source: "auto" | "asked"): Promise<ResolvedAccount> {
	const resolved = await useAccount(run, facts, name, source, false);
	if (resolved.block) return resolved;
	await writeStored(run.env.git, run.root, { account: name, remote: facts.remote }, facts.forge);
	return { ...resolved, notice: `livespec uses \`${name}\` for this repository (${NOTICE_WHY[source]})` };
}

async function useAccount(run: Run, facts: SelectionFacts, name: string, source: AccountSource, unverified: boolean): Promise<ResolvedAccount> {
	const token = await candidateToken(run.env, run.target, name, AbortSignal.timeout(ACCESS_TIMEOUT_MS));
	if (token === undefined) return blocked(run, facts, `could not read the token of ${name} for ${run.target.authority}; log in again, then run ${SWITCH_COMMAND}`);
	run.tokens.push(token);
	const user = candidateOf(facts, name)?.user ?? name;
	return { source, account: name, user, token, unverified, facts };
}

function candidateOf(facts: SelectionFacts, name: string): AccountCandidate | undefined {
	return facts.candidates.find((e) => e.candidate.name === name)?.candidate;
}

function blocked(run: Run, facts: SelectionFacts, message: string): ResolvedAccount {
	return { unverified: false, block: redactTokens(message, run.tokens), facts };
}

function ambiguousMessage(facts: SelectionFacts, options: string[]): string {
	return `several accounts can push to ${facts.remote}: ${options.join(", ")}; choose one with ${SWITCH_COMMAND}`;
}

function loginHint(target: ForgeTarget): string {
	return target.kind === "github"
		? `log in with an account that can push: gh auth login --hostname ${target.authority}`
		: `add a login that can push: tea login add --url ${target.baseUrl}`;
}

function refusalMessage(run: Run, facts: SelectionFacts, r: Extract<SelectionResult, { kind: "refuse" }>): string {
	const target = run.target;
	switch (r.reason) {
		case "ambiguous":
			return ambiguousMessage(facts, r.options);
		case "no-candidates":
			return `no account for ${target.authority} can write to ${facts.remote} (${run.noCandidates ?? "no candidates"}); ${loginHint(target)}`;
		case "no-access":
			return `no account can push to ${facts.remote} (checked: ${accessList(facts)}); ${loginHint(target)}, then run ${SWITCH_COMMAND}`;
		case "invalid":
			return `the account name is not valid for ${target.kind}; choose another with ${SWITCH_COMMAND}`;
	}
}

function accessList(facts: SelectionFacts): string {
	return facts.candidates.map((e) => `${e.candidate.name}: ${e.access}`).join(", ");
}

/**
 * The explicit switch of `/livespec account <name>`: refuses while the environment token decides, for
 * a name that is not a candidate, and for an account that cannot push; otherwise stores it. Never rejects.
 */
export async function chooseAccount(target: ForgeTarget, root: string, name: string, env: AccountEnv): Promise<ChooseResult> {
	const run: Run = { target, root, env, tokens: [] };
	const variable = envTokenVar(target);
	if (env.env[variable]) return { ok: false, message: `${variable} is set, so it decides the account for ${target.authority}; unset it to switch accounts.` };
	try {
		return await switchTo(run, name);
	} catch (error) {
		return { ok: false, message: redactTokens(`switching to ${name} failed: ${messageOf(error)}`, run.tokens) };
	}
}

async function switchTo(run: Run, name: string): Promise<ChooseResult> {
	const list = await listCandidates(run.env, run.target);
	const candidate = list.candidates.find((c) => c.name === name);
	if (!candidate) return { ok: false, message: unknownNameMessage(run.target, name, list.candidates, list.reason) };
	const access = await checkAccess(run.env, run.target, candidate);
	const facts: SelectionFacts = {
		...baseFacts(run.target, false, { hasUI: false }),
		candidates: [{ candidate, access }],
	};
	if (access !== "true") return { ok: false, message: deniedMessage(name, facts.remote, access) };
	const resolved = await storeAccount(run, facts, name, "asked");
	if (resolved.block) return { ok: false, message: resolved.block };
	return { ok: true, resolved };
}

function unknownNameMessage(target: ForgeTarget, name: string, candidates: AccountCandidate[], reason: string | undefined): string {
	const known = candidates.length > 0 ? `candidates: ${candidates.map((c) => c.name).join(", ")}` : (reason ?? "there are no candidates");
	return `${name} is not an account for ${target.authority}; ${known}. Nothing was stored.`;
}

function deniedMessage(name: string, remote: string, access: Access): string {
	const why = access === "false" ? "the forge denies write access" : "the access check gave no answer";
	return `${name} cannot push to ${remote} (${why}). Nothing was stored.`;
}
