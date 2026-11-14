// Forge detection: picks an adapter from the `origin` remote and the optional
// project config `.pi/livespec/config.yaml`. The Gitea probe is the last resort.

import { readFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ForgeError } from "./errors.ts";
import { GiteaForge } from "./gitea.ts";
import { defaultExec, GitHubForge, type ExecFn } from "./github.ts";
import type { Forge } from "./types.ts";

export interface DetectDeps {
	exec: ExecFn;
	fetch: typeof fetch;
	env: Record<string, string | undefined>;
	/** Returns the file text, or `undefined` when the file does not exist. */
	readFile: (path: string) => Promise<string | undefined>;
	homedir: string;
	platform: NodeJS.Platform;
}

interface RemoteRef {
	/** Lower-cased host name, without port. */
	host: string;
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
const PROBE_PATH = "/api/v1/version";
const PROBE_TIMEOUT_MS = 5000;
const SCP_LIKE_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;
const URL_SCHEMES = new Set(["https", "http", "ssh", "git+ssh"]);

/** Dependencies used when the caller passes none; the real environment. */
function resolveDeps(deps: Partial<DetectDeps>): DetectDeps {
	return {
		exec: deps.exec ?? defaultExec,
		fetch: deps.fetch ?? globalThis.fetch,
		env: deps.env ?? process.env,
		readFile: deps.readFile ?? readOptionalFile,
		homedir: deps.homedir ?? osHomedir(),
		platform: deps.platform ?? process.platform,
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
	const remote = parseRemote(await readOrigin(repoRoot, resolved.exec));
	if (!remote) {
		throw unsupported(`cannot parse the origin remote of ${repoRoot}; expected a https, ssh or scp-style URL`);
	}
	const config = parseConfig(await resolved.readFile(join(repoRoot, ...CONFIG_RELATIVE_PATH)));
	const repo = { owner: remote.owner, repo: remote.repo };

	if (config.forge === "gitea" && config.host) {
		return giteaFor(config.giteaUrl ?? `https://${config.host}`, repo, resolved);
	}
	if (config.forge === "github" || remote.host === "github.com" || config.githubHosts.includes(remote.host)) {
		return new GitHubForge({ ghPath: "gh", repo, exec: resolved.exec, ...(remote.host === "github.com" ? {} : { hostname: remote.host }) });
	}
	if (config.forge === "gitea") {
		return giteaFor(config.giteaUrl ?? remote.baseUrl, repo, resolved);
	}

	const baseUrl = config.giteaUrl ?? remote.baseUrl;
	await probeGitea(baseUrl, remote.host, resolved.fetch);
	return giteaFor(baseUrl, repo, resolved);
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
		baseUrl = `${webScheme}://${host}${port}`;
	} else {
		const match = SCP_LIKE_REMOTE.exec(url);
		if (!match) return null;
		host = match[1].toLowerCase();
		path = match[2];
		baseUrl = `https://${host}`;
	}

	const segments = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").split("/");
	if (segments.length !== 2 || segments.some((segment) => segment === "")) return null;
	return { host, baseUrl, owner: segments[0], repo: segments[1] };
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
		githubHosts: githubHosts.map((host) => host.toLowerCase()),
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

function giteaFor(baseUrl: string, repo: { owner: string; repo: string }, deps: DetectDeps): GiteaForge {
	return new GiteaForge({
		baseUrl,
		owner: repo.owner,
		repo: repo.repo,
		fetch: deps.fetch,
		env: deps.env,
		homedir: deps.homedir,
		platform: deps.platform,
	});
}

function unsupported(message: string): ForgeError {
	return new ForgeError({ code: "unsupported", operation: "detectForge", message });
}
