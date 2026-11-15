// Cross-flow secret handling: the real extension, real `detectForge` and
// `GitHubForge` over the executable fake `gh`, real git in a temp repo. Every
// `ExecFn`/`GitExec` argv is recorded; failures are injected that echo the
// token back, and every surface the user or the model sees is searched for it.

import { afterEach, describe, expect, test } from "vitest";
import type { AccountEnv } from "../../src/accounts/types.ts";
import type { GitExec } from "../../src/engine/git-exec.ts";
import extension from "../../src/extension.ts";
import { detectForge } from "../../src/forge/detect.ts";
import type { ExecFn, ExecResult } from "../../src/forge/github.ts";
import { getSession, setSession } from "../../src/hooks/session-store.ts";
import type { AccountRec, FakeGhData } from "../forge/fake-gh/state.ts";
import { FakePi, fakeCtx } from "../hooks/fake-pi.ts";
import { BUILD_LABELS, CHANGE_BRANCH, cardText, cleanupHomes, type Harness, harness, resumeBody, type ToolOut } from "../hooks/helpers.ts";

const TOKEN = "tok-ttdua-s3cr3t";
const TTDUA: AccountRec = { login: "ttdua", token: TOKEN, push: true };
const NAICOI: AccountRec = { login: "naicoi92", token: "tok-naicoi-s3cr3t", push: false };
const TOKENS = [TTDUA.token, NAICOI.token];

afterEach(async () => {
	setSession(undefined);
	await cleanupHomes();
});

/** Which `gh` call fails, echoing the token of its own environment in stderr. */
type Fault = "candidate-check" | "whoami" | "mutation";

const tokenOf = (env: Record<string, string> | undefined) => env?.GH_TOKEN ?? env?.GH_ENTERPRISE_TOKEN ?? "";
const echo = (env: Record<string, string> | undefined, status: number): ExecResult => ({
	stdout: "",
	stderr: `gh: request with token ${tokenOf(env)} failed (HTTP ${status})\n`,
	code: 1,
});

function faulted(fault: Fault | undefined, args: string[]): number | undefined {
	const method = args[args.indexOf("--method") + 1];
	if (fault === "candidate-check" && args[0] === "api" && args[1] === "repos/acme/shop" && !args.includes("--method")) return 500;
	if (fault === "whoami" && args[0] === "api" && args[1] === "user") return 401;
	if (fault === "mutation" && args[0] === "api" && args.includes("--method") && method === "PATCH") return 500;
	return undefined;
}

type World = { h: Harness; pi: FakePi; ctx: ReturnType<typeof fakeCtx>; argv: string[][]; issue: number };

/** Seeds a change issue for the branch straight into the fake `gh` state. */
function seedChange(h: Harness): number {
	return h.gh.update((d: FakeGhData) => {
		for (const label of BUILD_LABELS) if (!d.labels.includes(label)) d.labels.push(label);
		const number = d.nextNumber++;
		const at = "2026-01-01T00:00:00.000Z";
		d.issues[String(number)] = { number, title: "per-ip-cap", body: resumeBody(h.head), labels: [...BUILD_LABELS], state: "open", author: "someone", createdAt: at, updatedAt: at };
		return number;
	});
}

/** The real extension over a recording, optionally faulty `AccountEnv`; detection is the real `detectForge`. */
async function world(fault?: Fault): Promise<World> {
	const h = await harness({ branch: CHANGE_BRANCH, accounts: [NAICOI, TTDUA] });
	const issue = seedChange(h);
	const argv: string[][] = [];
	const inner = h.accounts;
	const exec: ExecFn = async (file, args, input, env, signal) => {
		argv.push([file, ...args]);
		const status = file === "gh" ? faulted(fault, args) : undefined;
		return status === undefined ? inner.exec(file, args, input, env, signal) : echo(env, status);
	};
	const git: GitExec = (args, opts) => {
		argv.push(["git", ...args]);
		return inner.git(args, opts);
	};
	const accounts: AccountEnv = { ...inner, exec, git };
	const pi = new FakePi();
	extension(pi.api as never, { home: h.home, accounts, content: () => h.content.manager, detect: detectForge });
	const ctx = fakeCtx(h.root);
	await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
	return { h, pi, ctx, argv, issue };
}

const commandCtx = (w: World) => ({ ...w.ctx, getSystemPromptOptions: () => ({ skills: [] }) });

async function command(w: World, args: string): Promise<string> {
	const before = w.pi.sent.length;
	await w.pi.commands.get("livespec")?.handler(args, commandCtx(w));
	return w.pi.sent.slice(before).map((m) => m.content).join("\n");
}

/** Runs a tool; a rejection is returned as its message, so a thrown error is searched too. */
async function tool(w: World, name: string, params: unknown): Promise<string> {
	try {
		const out = (await w.pi.tools.get(name)?.execute("call-1", params, undefined, undefined, w.ctx)) as ToolOut;
		return JSON.stringify({ content: out.content, details: out.details });
	} catch (error) {
		return `thrown: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function doctorLine(doctor: string, id: string): string {
	const lines = doctor.split("\n");
	const at = lines.findIndex((l) => l.includes(` ${id}: `));
	expect(at, `doctor has a ${id} result`).toBeGreaterThanOrEqual(0);
	return lines.slice(at, at + 2).join("\n");
}

function expectNoToken(surfaces: Record<string, string>): void {
	for (const [name, text] of Object.entries(surfaces)) {
		for (const token of TOKENS) expect(text, `${name} leaks a token`).not.toContain(token);
	}
}

describe("secret handling", () => {
	test("No token in arguments", async () => {
		const w = await world();
		const session = getSession();
		expect(session?.account).toMatchObject({ account: "ttdua", source: "auto" });
		expect(session?.accountBlock).toBeUndefined();

		await command(w, "account");
		await command(w, "account ttdua");
		await command(w, "account naicoi92");
		await command(w, "doctor");
		expect(JSON.parse(await tool(w, "spec_write", { section: "Proposal", content: "Cap requests per IP." }))).toMatchObject({ details: { number: w.issue } });

		const fakeGh = w.h.gh.read();
		const every = [...w.argv, ...fakeGh.argvLog];
		expect(every.length).toBeGreaterThan(0);
		for (const args of every) for (const token of TOKENS) expect(args.join(" ")).not.toContain(token);
		// The tokens did travel, through the environment only.
		expect(fakeGh.envLog.map((e) => e.GH_TOKEN)).toContain(TOKEN);
		expect(fakeGh.envLog.map((e) => e.GH_TOKEN)).toContain(NAICOI.token);
		// Many real fake-`gh` subprocesses: 2.5–4.5 s alone, above the 5 s default under full-suite load.
	}, 60_000);

	test("No token in output on failure", async () => {
		for (const fault of ["candidate-check", "whoami", "mutation"] as const) {
			const w = await world(fault);
			const session = getSession();
			if (!session) throw new Error(`${fault}: no session`);
			const written = await tool(w, "spec_write", { section: "Proposal", content: "Cap requests per IP." });
			const doctor = await command(w, "doctor");
			const card = await cardText(w.pi, w.ctx);
			const account = await command(w, "account");

			if (fault === "whoami") expect(session.accountBlock, fault).toContain("***");
			if (fault === "mutation") expect(written, fault).toContain("***");
			if (fault !== "mutation") expect(written, fault).toContain("refused");
			expectNoToken({
				tool: written,
				errors: session.errors.join("\n"),
				block: session.accountBlock ?? "",
				forgeError: session.forgeError ?? "",
				doctorForge: doctorLine(doctor, "forge"),
				doctorAccount: doctorLine(doctor, "forge-account"),
				doctor,
				card,
				account,
				notices: JSON.stringify(w.ctx.ui.notify.mock.calls),
				cardInput: JSON.stringify(session.card),
			});
		}
	}, 60_000);

});
