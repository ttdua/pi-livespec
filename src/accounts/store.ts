// The account stored in the clone's local git config (`livespec.account`,
// `livespec.accountRemote`). Only `--local` is read or written, so global and
// system values never count, and every operand follows `--end-of-options`.

import type { GitExec } from "../engine/git-exec.ts";
import type { StoredAccount } from "./types.ts";

export const ACCOUNT_KEY = "livespec.account";
export const ACCOUNT_REMOTE_KEY = "livespec.accountRemote";
/** Longest account name accepted for a `tea` login. */
export const MAX_NAME_LENGTH = 100;
/** `git config --get` exits 1 when the key is unset. */
const KEY_UNSET_EXIT = 1;
const CONTROL_CHARACTER = /\p{Cc}/u;
/** A GitHub login: alphanumerics and hyphens, at most 39 characters, not starting with a hyphen. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** `<host>/<owner>/<repo>`: three non-empty segments. */
const REMOTE_SHAPE = /^[^/]+\/[^/]+\/[^/]+$/;

export type AccountForge = "github" | "gitea";

const NAME_RULE: Readonly<Record<AccountForge, string>> = {
	github: "a GitHub login uses letters, digits and hyphens, at most 39 characters, and does not start with a hyphen",
	gitea: `it must be 1 to ${MAX_NAME_LENGTH} characters, without control characters, and not start with "-"`,
};
const REMOTE_RULE = 'it must be <host>/<owner>/<repo>, without control characters, and not start with "-"';

/** Non-empty, no control character, no leading `-`: the floor for every stored value. */
function isSafeText(value: string): boolean {
	return value !== "" && !value.startsWith("-") && !CONTROL_CHARACTER.test(value);
}

/** Whether `name` may be stored for `forge`: a GitHub login shape for GitHub, the generic rule for a `tea` login name; `any` is the generic rule. */
export function isSafeAccountName(name: string, forge: AccountForge | "any"): boolean {
	if (forge === "github") return GITHUB_LOGIN.test(name);
	return isSafeText(name) && name.length <= MAX_NAME_LENGTH;
}

/** Whether `remote` is `<host>/<owner>/<repo>` without control characters and not starting with `-`; no length cap. */
export function isSafeRemote(remote: string): boolean {
	return isSafeText(remote) && REMOTE_SHAPE.test(remote);
}

/** The stored account, or `undefined` when either key is unset or holds an unsafe value (generic name rule; the forge is not known here). */
export async function readStored(git: GitExec, root: string): Promise<StoredAccount | undefined> {
	const account = await readKey(git, root, ACCOUNT_KEY);
	if (account === undefined || !isSafeAccountName(account, "any")) return undefined;
	const remote = await readKey(git, root, ACCOUNT_REMOTE_KEY);
	if (remote === undefined || !isSafeRemote(remote)) return undefined;
	return { account, remote };
}

/** Stores both keys in the clone's local config. Throws for an unsafe value before running git, or when git fails. */
export async function writeStored(git: GitExec, root: string, s: StoredAccount, forge: AccountForge): Promise<void> {
	if (!isSafeAccountName(s.account, forge)) throw new Error(`invalid account name for ${ACCOUNT_KEY}: ${NAME_RULE[forge]}`);
	if (!isSafeRemote(s.remote)) throw new Error(`invalid remote for ${ACCOUNT_REMOTE_KEY}: ${REMOTE_RULE}`);
	await writeKey(git, root, ACCOUNT_KEY, s.account);
	await writeKey(git, root, ACCOUNT_REMOTE_KEY, s.remote);
}

async function readKey(git: GitExec, root: string, key: string): Promise<string | undefined> {
	const result = await git(["config", "--local", "--get", "--end-of-options", key], { cwd: root });
	if (result.code === KEY_UNSET_EXIT) return undefined;
	if (result.code !== 0) throw gitError(`git config --local --get ${key}`, result.stderr || result.spawnError);
	return result.stdout.replace(/\n$/, "");
}

async function writeKey(git: GitExec, root: string, key: string, value: string): Promise<void> {
	const result = await git(["config", "--local", "--end-of-options", key, value], { cwd: root });
	if (result.code !== 0) throw gitError(`git config --local ${key}`, result.stderr || result.spawnError);
}

function gitError(command: string, detail: string | undefined): Error {
	return new Error(`${command} failed: ${(detail ?? "").trim()}`);
}
