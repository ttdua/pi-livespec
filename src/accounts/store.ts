// The account stored in the clone's local git config (`livespec.account`,
// `livespec.accountRemote`). Only `--local` is read or written, so global and
// system values never count, and every operand follows `--end-of-options`.

import type { GitExec } from "../engine/git-exec.ts";
import type { StoredAccount } from "./types.ts";

export const ACCOUNT_KEY = "livespec.account";
export const ACCOUNT_REMOTE_KEY = "livespec.accountRemote";
/** Longest value accepted for either key. */
export const MAX_VALUE_LENGTH = 100;
/** `git config --get` exits 1 when the key is unset. */
const KEY_UNSET_EXIT = 1;
const CONTROL_CHARACTER = /\p{Cc}/u;

/** A value is safe to store: non-empty, at most `MAX_VALUE_LENGTH` characters, no control character, no leading `-`. */
export function isSafeValue(value: string): boolean {
	return value !== "" && value.length <= MAX_VALUE_LENGTH && !value.startsWith("-") && !CONTROL_CHARACTER.test(value);
}

/** The stored account, or `undefined` when either key is unset or holds an unsafe value. */
export async function readStored(git: GitExec, root: string): Promise<StoredAccount | undefined> {
	const account = await readKey(git, root, ACCOUNT_KEY);
	if (account === undefined || !isSafeValue(account)) return undefined;
	const remote = await readKey(git, root, ACCOUNT_REMOTE_KEY);
	if (remote === undefined || !isSafeValue(remote)) return undefined;
	return { account, remote };
}

/** Stores both keys in the clone's local config. Throws for an unsafe value before running git, or when git fails. */
export async function writeStored(git: GitExec, root: string, s: StoredAccount): Promise<void> {
	if (!isSafeValue(s.account)) throw new Error(`invalid account name for ${ACCOUNT_KEY}: ${valueRule()}`);
	if (!isSafeValue(s.remote)) throw new Error(`invalid remote for ${ACCOUNT_REMOTE_KEY}: ${valueRule()}`);
	await writeKey(git, root, ACCOUNT_KEY, s.account);
	await writeKey(git, root, ACCOUNT_REMOTE_KEY, s.remote);
}

function valueRule(): string {
	return `it must be 1 to ${MAX_VALUE_LENGTH} characters, without control characters, and not start with "-"`;
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
