// Forge detection: resolves the forge endpoint (`ForgeTarget`) from the
// `origin` remote, the optional project config `.pi/livespec/config.yaml` and
// the `tea` logins' SSH hosts, then builds the adapter for it. The Gitea probe
// is the last resort.

import { readFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ForgeError } from "./errors.ts";
import { GiteaForge } from "./gitea.ts";
import { defaultExec, GitHubForge, type ExecFn } from "./github.ts";
import { type TeaLookup, teaLogins } from "./tea-config.ts";
import type { Forge } from "./types.ts";

export interface DetectDeps {
	exec: ExecFn;
	fetch: typeof fetch;
	env: Record<string, string | undefined>;
	/** Returns the file text, or `undefined` when the file does not exist. */
	readFile: (path: string) => Promise<string | undefined>;
	homedir: string;
	platform: NodeJS.Platform;
	/** Account chosen for this clone: `token` goes to GitHub, `name` to Gitea as the `tea` login. */
	account?: { name: string; token?: string };
	/** Where the `tea` config is read from; defaults to tea's own lookup over `env`, `homedir` and `platform`. */
	teaLookup?: Omit<TeaLookup, "baseUrl" | "login">;
}

/** The forge endpoint of a repository, shared by account resolution and the adapter. */
export interface ForgeTarget {
	kind: "github" | "gitea";
	/** Lower-cased host name of the web/API server, without port. */
	host: string;
	/** `host` plus a non-default http(s) port. */
	authority: string;
	/** Server root, e.g. `https://gitea.example.org`. */
	baseUrl: string;
	owner: string;
	repo: string;
}


interface RemoteRef {
	/** Lower-cased host name, without port. */
	host: string;
	/** Host plus the http(s) port when the remote carries one; never an SSH daemon port. */
	authority: string;
	/** Server root used for the Gitea probe, e.g. `https://git.example.org`. */
	baseUrl: string;
	owner: string;
	repo: string;
}

interface ProjectConfig {
	forge?: "github" | "gitea";
	host?: string;
	githubHosts: string[];
	giteaUrl?: string;
}

const CONFIG_RELATIVE_PATH = [".pi", "livespec", "config.yaml"];
const GITHUB_HOST = "github.com";
const PROBE_PATH = "/api/v1/version";
const PROBE_TIMEOUT_MS = 5000;
const SCP_LIKE_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;
const URL_SCHEMES = new Set(["https", "http", "ssh", "git+ssh"]);

type TeaConfigLookup = Omit<TeaLookup, "baseUrl" | "login">;
type ResolvedDeps = Omit<DetectDeps, "teaLookup"> & { teaLookup: TeaConfigLookup };

/** Dependencies used when the caller passes none; the real environment. */
function resolveDeps(deps: Partial<DetectDeps>): ResolvedDeps {
	const env = deps.env ?? process.env;
	const homedir = deps.homedir ?? osHomedir();
	const platform = deps.platform ?? process.platform;
	return {
		exec: deps.exec ?? defaultExec,
		fetch: deps.fetch ?? globalThis.fetch,
		env,
		readFile: deps.readFile ?? readOptionalFile,
		homedir,
		platform,
		account: deps.account,
		teaLookup: deps.teaLookup ?? { env, homedir, platform },
	};
}

async function readOptionalFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Detects the forge for a repository. Throws `ForgeError` with code `unsupported` when no rule matches. */
export async function detectForge(repoRoot: string, deps: Partial<DetectDeps> = {}): Promise<Forge> {
	const resolved = resolveDeps(deps);
	return adapterFor(await resolveForgeTarget(repoRoot, resolved), resolved);
}

/**
 * Resolves the forge endpoint of a repository: the same rules `detectForge`
 * uses, so account resolution and the adapter talk to one server. Throws
 * `ForgeError` with code `unsupported` when no rule matches.
 */
export async function resolveForgeTarget(repoRoot: string, deps: Partial<DetectDeps> = {}): Promise<ForgeTarget> {
	const resolved = resolveDeps(deps);
	const remote = parseRemote(await readOrigin(repoRoot, resolved.exec));
	if (!remote) {
		throw unsupported(`cannot parse the origin remote of ${repoRoot}; expected a https, ssh or scp-style URL`);
	}
	const config = parseConfig(await resolved.readFile(join(repoRoot, ...CONFIG_RELATIVE_PATH)));
	const configured = configuredTarget(remote, config);
	if (configured) return configured;
	const byTeaSshHost = await teaSshTarget(remote, config, resolved);
	if (byTeaSshHost) return byTeaSshHost;
	return probedTarget(remote, config, resolved);
}

/** The target the remote and the project config decide alone, without any I/O; `undefined` when they do not. */
function configuredTarget(remote: RemoteRef, config: ProjectConfig): ForgeTarget | undefined {
	if (config.forge === "gitea" && config.host) return giteaTarget(config.giteaUrl ?? `https://${config.host}`, remote);
	if (config.forge === "github" || remote.host === GITHUB_HOST || config.githubHosts.includes(remote.host)) {
		return { kind: "github", host: remote.host, authority: remote.authority, baseUrl: remote.baseUrl, owner: remote.owner, repo: remote.repo };
	}
	if (config.forge === "gitea") return giteaTarget(config.giteaUrl ?? remote.baseUrl, remote);
	return undefined;
}

/**
 * Without Gitea config, the web URL of the `tea` login whose `ssh_host` is the
 * origin host (case-insensitive, port ignored). Several different URLs for that
 * host are not guessed between: `undefined`, so the probe decides.
 */
async function teaSshTarget(remote: RemoteRef, config: ProjectConfig, deps: ResolvedDeps): Promise<ForgeTarget | undefined> {
	if (config.giteaUrl !== undefined) return undefined;
	const logins = await teaLogins({ ...deps.teaLookup, baseUrl: remote.baseUrl });
	const urls = new Set(
		logins.filter((l) => l.sshHost !== undefined && stripPort(l.sshHost.toLowerCase()) === remote.host).map((l) => trimSlashes(l.url)),
	);
	const [url] = urls;
	return urls.size === 1 ? giteaTarget(url, remote) : undefined;
}

/** Last resort: a Gitea at the `giteaUrl` override or the origin host, when it answers the version probe. */
async function probedTarget(remote: RemoteRef, config: ProjectConfig, deps: ResolvedDeps): Promise<ForgeTarget> {
	const baseUrl = config.giteaUrl ?? remote.baseUrl;
	await probeGitea(baseUrl, remote.host, deps.fetch);
	return giteaTarget(baseUrl, remote);
}

/** A Gitea target at `webUrl`, for the repository named by the remote. */
function giteaTarget(webUrl: string, remote: RemoteRef): ForgeTarget {
	let url: URL;
	try {
		url = new URL(webUrl);
	} catch {
		throw unsupported(`invalid Gitea URL "${webUrl}"; set giteaUrl in .pi/livespec/config.yaml to an http(s) URL`);
	}
	const host = url.hostname.toLowerCase();
	return {
		kind: "gitea",
		host,
		authority: url.port ? `${host}:${url.port}` : host,
		baseUrl: trimSlashes(webUrl),
		owner: remote.owner,
		repo: remote.repo,
	};
}

/** Builds the adapter for `target`, handing it the account of `deps`. */
function adapterFor(target: ForgeTarget, deps: ResolvedDeps): Forge {
	const repo = { owner: target.owner, repo: target.repo };
	if (target.kind === "github") {
		return new GitHubForge({
			ghPath: "gh",
			repo,
			exec: deps.exec,
			...(target.host === GITHUB_HOST ? {} : { hostname: target.authority }),
			...(deps.account?.token ? { token: deps.account.token } : {}),
		});
	}
	return new GiteaForge({
		baseUrl: target.baseUrl,
		...repo,
		fetch: deps.fetch,
		...deps.teaLookup,
		// `GITEA_TOKEN` still comes from detection's own environment.
		env: deps.env,
		...(deps.account ? { login: deps.account.name } : {}),
	});
}

async function readOrigin(repoRoot: string, exec: ExecFn): Promise<string> {
	const result = await exec("git", ["-C", repoRoot, "remote", "get-url", "origin"]);
	if (result.spawnError !== undefined || result.code !== 0) {
		const detail = (result.stderr || result.spawnError || "").trim();
		throw unsupported(`${repoRoot} has no origin remote (${detail}); add one with git remote add origin <url>`);
	}
	return result.stdout.trim();
}

/** Parses https/http/ssh URLs and scp-style `user@host:owner/repo` remotes. Returns `null` when unrecognised. */
export function parseRemote(raw: string): RemoteRef | null {
	const url = raw.trim();
	let host: string;
	let path: string;
	let baseUrl: string;
	let authority: string;

	if (url.includes("://")) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return null;
		}
		const scheme = parsed.protocol.replace(/:$/, "");
		if (!URL_SCHEMES.has(scheme)) return null;
		host = parsed.hostname.toLowerCase();
		path = parsed.pathname;
		// An ssh port is the SSH daemon's, not the web server's; only http(s) keeps it.
		const webScheme = scheme === "http" || scheme === "https" ? scheme : "https";
		const port = webScheme === scheme && parsed.port ? `:${parsed.port}` : "";
		authority = `${host}${port}`;
		baseUrl = `${webScheme}://${authority}`;
	} else {
		const match = SCP_LIKE_REMOTE.exec(url);
		if (!match) return null;
		host = match[1].toLowerCase();
		path = match[2];
		authority = host;
		baseUrl = `https://${host}`;
	}

	const segments = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").split("/");
	if (segments.length !== 2 || segments.some((segment) => segment === "")) return null;
	return { host, authority, baseUrl, owner: segments[0], repo: segments[1] };
}

/** Drops a trailing `:port` from a host entry; bracketed or bare IPv6 literals are left alone. */
function stripPort(host: string): string {
	return host.replace(/^([^:[\]]+):\d+$/, "$1");
}

/** Reads the optional project config. A missing file means no configuration. */
function parseConfig(text: string | undefined): ProjectConfig {
	const empty: ProjectConfig = { githubHosts: [] };
	if (text === undefined) return empty;

	const data: unknown = parse(text);
	if (data === null || data === undefined) return empty;
	if (typeof data !== "object" || Array.isArray(data)) {
		throw unsupported("invalid .pi/livespec/config.yaml: expected a mapping at the top level");
	}
	const raw = data as Record<string, unknown>;

	const forge = raw.forge;
	if (forge !== undefined && forge !== "github" && forge !== "gitea") {
		throw unsupported(`invalid .pi/livespec/config.yaml: forge must be "github" or "gitea", got ${String(forge)}`);
	}
	const githubHosts = raw.githubHosts ?? [];
	if (!Array.isArray(githubHosts) || githubHosts.some((host) => typeof host !== "string")) {
		throw unsupported("invalid .pi/livespec/config.yaml: githubHosts must be a list of host names");
	}
	return {
		forge,
		host: typeof raw.host === "string" ? raw.host.toLowerCase() : undefined,
		githubHosts: githubHosts.map((host) => stripPort(host.trim().toLowerCase())),
		giteaUrl: typeof raw.giteaUrl === "string" ? raw.giteaUrl : undefined,
	};
}

/** Succeeds only when the host answers `/api/v1/version` with a JSON body holding a `version` string. */
async function probeGitea(baseUrl: string, host: string, fetchFn: typeof fetch): Promise<void> {
	const url = `${baseUrl.replace(/\/+$/, "")}${PROBE_PATH}`;
	let response: Response;
	try {
		response = await fetchFn(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw unsupported(
			`could not reach ${host} to probe ${PROBE_PATH} (${reason}); configure forge in .pi/livespec/config.yaml`,
		);
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw unsupported(unknownHostMessage(host));
	}
	if (!(await hasVersionField(response))) {
		throw unsupported(unknownHostMessage(host));
	}
}

async function hasVersionField(response: Response): Promise<boolean> {
	try {
		const body: unknown = await response.json();
		return typeof body === "object" && body !== null && typeof (body as { version?: unknown }).version === "string";
	} catch {
		return false;
	}
}

function unknownHostMessage(host: string): string {
	return `unknown forge host "${host}": it is not github.com, not a configured GitHub host, and did not answer ${PROBE_PATH}; set forge: gitea (with host) or githubHosts in .pi/livespec/config.yaml`;
}

function trimSlashes(url: string): string {
	return url.replace(/\/+$/, "");
}

function unsupported(message: string): ForgeError {
	return new ForgeError({ code: "unsupported", operation: "detectForge", message });
}
