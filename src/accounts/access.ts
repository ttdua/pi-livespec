// Write-access check of one candidate, with that candidate's own token: the
// active `gh` account and `GITEA_TOKEN` are never used. `permissions.push`
// decides; HTTP 401/403/404 is no access; a missing field, a failure or the
// timeout is `unknown`.

import type { ForgeTarget } from "../forge/detect.ts";
import { tokenEnvVar } from "../forge/github.ts";
import { candidateToken } from "./token.ts";
import type { Access, AccountCandidate, AccountEnv } from "./types.ts";

/** Cap of one candidate check, token lookup included. */
export const ACCESS_TIMEOUT_MS = 5_000;
/** Checks running at once. */
export const ACCESS_CONCURRENCY = 4;

export type AccessDeps = Pick<AccountEnv, "exec" | "fetch" | "teaLookup">;

export interface CandidateAccess {
	candidate: AccountCandidate;
	access: Access;
}

/** Statuses that mean the token cannot see or push to the repository. */
const DENIED_STATUSES = new Set([401, 403, 404]);
const GH_HTTP_STATUS = /\(HTTP (\d{3})\)/;

/** Whether `candidate` can push to the target repository; resolves within `ACCESS_TIMEOUT_MS`, never rejects. */
export async function checkAccess(d: AccessDeps, target: ForgeTarget, candidate: AccountCandidate): Promise<Access> {
	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<Access>((resolve) => {
		timer = setTimeout(() => {
			abort.abort();
			resolve("unknown");
		}, ACCESS_TIMEOUT_MS);
	});
	try {
		return await Promise.race([checkWithToken(d, target, candidate.name, abort.signal), timeout]);
	} catch {
		// Any unexpected failure of the check (unreadable tea config, fetch error) is not write access.
		return "unknown";
	} finally {
		clearTimeout(timer);
	}
}

/** Checks every candidate, at most `ACCESS_CONCURRENCY` at once; results keep the input order. */
export async function checkAll(d: AccessDeps, target: ForgeTarget, candidates: AccountCandidate[]): Promise<CandidateAccess[]> {
	const results: CandidateAccess[] = new Array(candidates.length);
	let next = 0;
	const worker = async () => {
		while (next < candidates.length) {
			const index = next++;
			const candidate = candidates[index] as AccountCandidate;
			results[index] = { candidate, access: await checkAccess(d, target, candidate) };
		}
	};
	await Promise.all(Array.from({ length: Math.min(ACCESS_CONCURRENCY, candidates.length) }, worker));
	return results;
}

async function checkWithToken(d: AccessDeps, target: ForgeTarget, name: string, signal: AbortSignal): Promise<Access> {
	const token = await candidateToken(d, target, name);
	if (token === undefined) return "unknown";
	return target.kind === "github" ? githubAccess(d, target, token) : giteaAccess(d, target, token, signal);
}

async function githubAccess(d: AccessDeps, target: ForgeTarget, token: string): Promise<Access> {
	const route = `repos/${target.owner}/${target.repo}`;
	const result = await d.exec("gh", ["api", route, "--hostname", target.authority], undefined, { [tokenEnvVar(target.authority)]: token });
	if (result.spawnError !== undefined) return "unknown";
	if (result.code !== 0) return deniedOrUnknown(Number(GH_HTTP_STATUS.exec(result.stderr)?.[1]));
	return pushOf(parseJson(result.stdout));
}

async function giteaAccess(d: AccessDeps, target: ForgeTarget, token: string, signal: AbortSignal): Promise<Access> {
	const url = `${target.baseUrl.replace(/\/+$/, "")}/api/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
	const response = await d.fetch(url, { headers: { accept: "application/json", authorization: `token ${token}` }, signal });
	if (!response.ok) return deniedOrUnknown(response.status);
	return pushOf(parseJson(await response.text()));
}

function deniedOrUnknown(status: number): Access {
	return DENIED_STATUSES.has(status) ? "false" : "unknown";
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** `permissions.push` of a repository response; anything but a boolean is `unknown`. */
function pushOf(repo: unknown): Access {
	const push = (repo as { permissions?: { push?: unknown } } | null | undefined)?.permissions?.push;
	if (typeof push !== "boolean") return "unknown";
	return push ? "true" : "false";
}
