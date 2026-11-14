// Token lookup for Gitea: `GITEA_TOKEN`, else the `tea` config login whose url
// has the same host as the server. The config is read, `tea` is never run.

import { readFile } from "node:fs/promises";
import { homedir as osHomedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

export interface TeaLookup {
	/** Server root whose host selects the `tea` login. */
	baseUrl: string;
	env: Record<string, string | undefined>;
	/** Path of the `tea` config; when omitted, tea's own lookup order is followed. */
	teaConfigPath?: string;
	homedir?: string;
	platform?: NodeJS.Platform;
}

/** `GITEA_TOKEN` when set and non-empty, else the matching `tea` login's token, else `undefined`. */
export async function findGiteaToken(lookup: TeaLookup): Promise<string | undefined> {
	return lookup.env.GITEA_TOKEN || (await tokenFromTeaConfig(lookup));
}

/** Reads the token of the `tea` login whose url has the same host as `baseUrl`. */
async function tokenFromTeaConfig(lookup: TeaLookup): Promise<string | undefined> {
	const config = await readTeaConfig(lookup);
	const host = hostOf(lookup.baseUrl);
	const logins = (config as { logins?: { url?: string; token?: string }[] } | null)?.logins;
	const login = Array.isArray(logins) ? logins.find((l) => l?.url && hostOf(l.url) === host && l.token) : undefined;
	return login?.token;
}

/** The first readable `tea` config: the explicit path, else tea's own lookup order. */
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
