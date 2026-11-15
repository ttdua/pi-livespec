// Token lookup for Gitea: `GITEA_TOKEN`, else the named `tea` login, else the
// single `tea` login whose url has the same host as the server. The config is
// read, `tea` is never run.

import { readFile } from "node:fs/promises";
import { homedir as osHomedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ForgeError } from "./errors.ts";

export interface TeaLookup {
	/** Server root whose host selects the `tea` login. */
	baseUrl: string;
	env: Record<string, string | undefined>;
	/** Path of the `tea` config; when omitted, tea's own lookup order is followed. */
	teaConfigPath?: string;
	homedir?: string;
	platform?: NodeJS.Platform;
	/** Name of the `tea` login to use; its URL host must equal the server's. */
	login?: string;
}

/** One usable `tea` login: entries without a name, url or token are left out. */
export interface TeaLogin {
	name: string;
	url: string;
	/** `user` of the entry; empty when the config omits it. */
	user: string;
	token: string;
	/** `ssh_host` of the entry, when set. */
	sshHost?: string;
}

const TOKEN_OPERATION = "findGiteaToken";

/**
 * `GITEA_TOKEN` when set and non-empty; else the token of the login named by
 * `lookup.login`; else the token of the single login whose url host matches
 * `baseUrl`; else `undefined`. Throws `ForgeError("auth")` for a named login
 * that is missing or belongs to another host, and when several logins match
 * and none is named.
 */
export async function findGiteaToken(lookup: TeaLookup): Promise<string | undefined> {
	if (lookup.env.GITEA_TOKEN) return lookup.env.GITEA_TOKEN;
	const host = hostOf(lookup.baseUrl);
	const logins = await teaLogins(lookup);
	if (lookup.login !== undefined) return namedLogin(logins, lookup.login, host).token;
	return singleLoginFor(logins, host)?.token;
}

/** Every usable login of the `tea` config. Reads the file only, never spawns `tea`; a malformed config gives none. */
export async function teaLogins(lookup: TeaLookup): Promise<TeaLogin[]> {
	const config = await readTeaConfig(lookup);
	const entries = (config as { logins?: unknown } | null | undefined)?.logins;
	if (!Array.isArray(entries)) return [];
	return entries.flatMap((entry) => {
		const login = toTeaLogin(entry);
		return login ? [login] : [];
	});
}

function toTeaLogin(entry: unknown): TeaLogin | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const raw = entry as Record<string, unknown>;
	const { name, url, token, user, ssh_host: sshHost } = raw;
	if (!isFilled(name) || !isFilled(url) || !isFilled(token)) return undefined;
	const login: TeaLogin = { name, url, user: typeof user === "string" ? user : "", token };
	if (isFilled(sshHost)) login.sshHost = sshHost;
	return login;
}

function isFilled(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

function namedLogin(logins: TeaLogin[], name: string, host: string | undefined): TeaLogin {
	const login = logins.find((l) => l.name === name);
	if (!login) throw authError(`tea login "${name}" is not in the tea config`);
	if (hostOf(login.url) !== host) {
		throw authError(`tea login "${name}" is for ${hostOf(login.url) ?? login.url}, not ${host ?? "this server"}`);
	}
	return login;
}

/** The single login for `host`; several of them is ambiguous and never resolved by file order. */
function singleLoginFor(logins: TeaLogin[], host: string | undefined): TeaLogin | undefined {
	const matches = logins.filter((l) => hostOf(l.url) === host);
	if (matches.length > 1) {
		const names = matches.map((l) => l.name).join(", ");
		throw authError(`several tea logins for ${host}: ${names}; choose one with /livespec account <name>`);
	}
	return matches[0];
}

function authError(message: string): ForgeError {
	return new ForgeError({ code: "auth", operation: TOKEN_OPERATION, message });
}

/** The first readable `tea` config: the explicit path, else tea's own lookup order. Invalid YAML gives `undefined`. */
async function readTeaConfig(lookup: TeaLookup): Promise<unknown> {
	for (const path of teaConfigCandidates(lookup)) {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch {
			continue;
		}
		try {
			return parse(text);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function teaConfigCandidates(lookup: TeaLookup): string[] {
	if (lookup.teaConfigPath) return [lookup.teaConfigPath];
	const home = lookup.homedir ?? osHomedir();
	const xdg = lookup.env.XDG_CONFIG_HOME;
	const base = xdg ? xdg : (lookup.platform ?? osPlatform()) === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config");
	return [join(base, "tea", "config.yml"), join(home, ".tea", "tea.yml")];
}

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).host;
	} catch {
		return undefined;
	}
}
