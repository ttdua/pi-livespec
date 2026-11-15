// Fakes for account discovery and access tests: a scripted `gh` as an
// `ExecFn`, a loopback Gitea serving `GET /api/v1/repos/{o}/{r}` per token,
// temp `tea` configs and forge targets. Nothing here reads real credentials.

import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountEnv } from "../../src/accounts/types.ts";
import type { ForgeTarget } from "../../src/forge/detect.ts";
import type { ExecFn, ExecResult } from "../../src/forge/github.ts";

/** How the repository endpoint answers for one account. */
export type RepoAnswer = boolean | "missing" | "unreachable" | "hang" | { status: number };

export interface FakeAccount {
	login: string;
	token: string;
	repo: RepoAnswer;
	/** Delay before the repository answer, in ms. */
	delayMs?: number;
}

export interface ExecCall {
	file: string;
	args: string[];
	env?: Record<string, string>;
}

export interface FakeGhOptions {
	accounts: FakeAccount[];
	/** Login of the active `gh` account; its token is what `gh` uses without an env token. */
	active?: string;
	/** Simulates a `gh` that does not know `auth status --json`. */
	noJsonStatus?: boolean;
	/** Raw stdout of `auth status --json hosts`, replacing the generated one. */
	statusStdout?: string;
}

export interface FakeGh {
	exec: ExecFn;
	calls: ExecCall[];
	/** Highest number of `gh api` calls in flight at once. */
	maxInFlight: () => number;
}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0 });
const failed = (stderr: string): ExecResult => ({ stdout: "", stderr, code: 1 });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function flagValue(args: string[], flag: string): string | undefined {
	const at = args.indexOf(flag);
	return at === -1 ? undefined : args[at + 1];
}

/** A scripted `gh`: `auth status --hostname h --json hosts`, `auth token --hostname h --user u`, `api repos/{o}/{r} --hostname h`. */
export function fakeGh(opts: FakeGhOptions): FakeGh {
	const calls: ExecCall[] = [];
	let inFlight = 0;
	let maxInFlight = 0;

	const authStatus = (args: string[]): ExecResult => {
		if (opts.noJsonStatus) return failed("unknown flag: --json\n\nUsage:  gh auth status [flags]\n");
		if (opts.statusStdout !== undefined) return ok(opts.statusStdout);
		const host = flagValue(args, "--hostname") ?? "github.com";
		const entries = opts.accounts.map((a) => ({ state: "success", active: a.login === opts.active, host, login: a.login, tokenSource: "keyring" }));
		return ok(`${JSON.stringify({ hosts: { [host]: entries } })}\n`);
	};

	const authToken = (args: string[]): ExecResult => {
		const account = opts.accounts.find((a) => a.login === flagValue(args, "--user"));
		return account ? ok(`${account.token}\n`) : failed("no oauth token found\n");
	};

	const api = async (args: string[], env: Record<string, string> | undefined): Promise<ExecResult> => {
		const token = env?.GH_TOKEN ?? env?.GH_ENTERPRISE_TOKEN ?? opts.accounts.find((a) => a.login === opts.active)?.token;
		const account = opts.accounts.find((a) => a.token === token);
		if (!account) return failed("gh: Bad credentials (HTTP 401)\n");
		if (account.repo === "hang") return new Promise<ExecResult>(() => {});
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			if (account.delayMs) await sleep(account.delayMs);
			return repoResult(account.repo);
		} finally {
			inFlight--;
		}
	};

	const exec: ExecFn = async (file, args, _input, env) => {
		calls.push({ file, args, env });
		if (file !== "gh") return failed(`fake gh: unexpected program ${file}`);
		if (args[0] === "auth" && args[1] === "status") return authStatus(args);
		if (args[0] === "auth" && args[1] === "token") return authToken(args);
		if (args[0] === "api") return api(args, env);
		return failed(`fake gh: unsupported ${args.join(" ")}`);
	};
	return { exec, calls, maxInFlight: () => maxInFlight };
}

function repoResult(answer: Exclude<RepoAnswer, "hang">): ExecResult {
	if (answer === "unreachable") return failed("error connecting to api.github.com\n");
	if (typeof answer === "object") return failed(`gh: Not Found (HTTP ${answer.status})\n`);
	const permissions = answer === "missing" ? undefined : { pull: true, push: answer, admin: false };
	return ok(`${JSON.stringify({ full_name: "acme/widgets", ...(permissions ? { permissions } : {}) })}\n`);
}

/** A loopback Gitea answering `GET /api/v1/repos/acme/widgets` per `authorization: token …`. */
export interface FakeGiteaRepo {
	url: string;
	authorizations: string[];
	close: () => Promise<void>;
}

export async function fakeGiteaRepo(accounts: FakeAccount[]): Promise<FakeGiteaRepo> {
	const authorizations: string[] = [];
	const server: Server = createServer((req, res) => {
		const auth = req.headers.authorization ?? "";
		authorizations.push(auth);
		const account = accounts.find((a) => auth === `token ${a.token}`);
		if (req.method !== "GET" || req.url !== "/api/v1/repos/acme/widgets") return void res.writeHead(404).end("{}");
		if (!account) return void res.writeHead(401).end('{"message":"token is required"}');
		const answer = account.repo;
		if (answer === "hang") return;
		if (answer === "unreachable") return void req.socket.destroy();
		if (typeof answer === "object") return void res.writeHead(answer.status).end("{}");
		const body = answer === "missing" ? {} : { permissions: { admin: false, push: answer, pull: true } };
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ full_name: "acme/widgets", ...body }));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		authorizations,
		close: () =>
			new Promise<void>((r) => {
				server.closeAllConnections();
				server.close(() => r());
			}),
	};
}

export async function teaConfig(text: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "tea-"));
	const path = join(dir, "config.yml");
	await writeFile(path, text);
	return path;
}

export function githubTarget(host = "github.com"): ForgeTarget {
	return { kind: "github", host, authority: host, baseUrl: `https://${host}`, owner: "acme", repo: "widgets" };
}

export function giteaTarget(baseUrl: string): ForgeTarget {
	const url = new URL(baseUrl);
	return { kind: "gitea", host: url.hostname, authority: url.host, baseUrl, owner: "acme", repo: "widgets" };
}

/** An `AccountEnv` over the fakes; `git` and `fetch` fail loudly unless given. */
export function fakeEnv(parts: Partial<AccountEnv> & { teaConfigPath?: string }): AccountEnv {
	const { teaConfigPath = "/nonexistent/tea.yml", ...rest } = parts;
	return {
		exec: async () => failed("no exec in this test"),
		git: async () => failed("no git in this test"),
		env: {},
		fetch: async () => {
			throw new Error("no fetch in this test");
		},
		teaLookup: { env: {}, teaConfigPath },
		now: () => 0,
		...rest,
	};
}
