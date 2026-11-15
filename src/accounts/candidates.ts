// Candidate discovery for a forge target: every `gh` account on the target's
// host, or every `tea` login whose URL host is the target's web host. Active
// and default markers are ignored.

import { untrusted } from "../hooks/phase-card.ts";
import type { ForgeTarget } from "../forge/detect.ts";
import { type TeaLogin, teaLogins } from "../forge/tea-config.ts";
import type { AccountCandidate, AccountEnv } from "./types.ts";

export type CandidateDeps = Pick<AccountEnv, "exec" | "teaLookup">;

export interface CandidateList {
	candidates: AccountCandidate[];
	/** Why the list is empty, readable by the user; set only when there are no candidates. */
	reason?: string;
}

const GH = "gh";

export async function listCandidates(d: CandidateDeps, target: ForgeTarget): Promise<CandidateList> {
	return target.kind === "github" ? githubCandidates(d, target.authority) : giteaCandidates(d, target);
}

/** Every account `gh auth status --json hosts` lists for `host`; the GitHub user is the login. */
async function githubCandidates(d: CandidateDeps, host: string): Promise<CandidateList> {
	const result = await d.exec(GH, ["auth", "status", "--hostname", host, "--json", "hosts"]);
	if (result.spawnError !== undefined || result.code !== 0) {
		const detail = (result.stderr || result.spawnError || "").trim().split("\n")[0];
		return none(`gh auth status --json hosts failed (${untrusted(detail ?? "")}); upgrade gh to a version that supports it`);
	}
	const logins = parseHostLogins(result.stdout, host);
	if (logins === undefined) return none("gh auth status --json hosts gave unexpected output; upgrade gh");
	if (logins.length === 0) return none(`no gh account for ${host}; log in with gh auth login --hostname ${host}`);
	return { candidates: logins.map((login) => ({ name: login, user: login })) };
}

/** Logins under `hosts[host]`, deduplicated in order; `undefined` when the output is not that shape. */
function parseHostLogins(stdout: string, host: string): string[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	const hosts = (parsed as { hosts?: unknown } | null)?.hosts;
	if (typeof hosts !== "object" || hosts === null) return undefined;
	const entries = (hosts as Record<string, unknown>)[host] ?? [];
	if (!Array.isArray(entries)) return undefined;
	const logins = entries.flatMap((e) => {
		const login = (e as { login?: unknown } | null)?.login;
		return typeof login === "string" && login !== "" ? [login] : [];
	});
	return [...new Set(logins)];
}

async function giteaCandidates(d: CandidateDeps, target: ForgeTarget): Promise<CandidateList> {
	const candidates = (await targetTeaLogins(d, target)).map((l) => ({ name: l.name, user: l.user }));
	if (candidates.length === 0) return none(`no tea login for ${target.baseUrl}; add one with tea login add --url ${target.baseUrl}`);
	return { candidates };
}

/** Every `tea` login whose URL host (port included) is the target's web authority. */
export async function targetTeaLogins(d: Pick<AccountEnv, "teaLookup">, target: ForgeTarget): Promise<TeaLogin[]> {
	const logins = await teaLogins({ ...d.teaLookup, baseUrl: target.baseUrl });
	return logins.filter((l) => urlAuthority(l.url) === target.authority);
}

function urlAuthority(url: string): string | undefined {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return undefined;
	}
}

function none(reason: string): CandidateList {
	return { candidates: [], reason };
}
