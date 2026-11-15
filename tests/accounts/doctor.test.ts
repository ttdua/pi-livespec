// The `forge-account` doctor check: unit cases over `DoctorDeps` (which must
// be the only thing it reads) and `/livespec doctor` through the real
// extension over a session started by the hook harness.

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkForgeAccount } from "../../src/accounts/doctor.ts";
import type { ResolvedAccount } from "../../src/accounts/resolve.ts";
import type { DoctorDeps } from "../../src/commands/doctor.ts";
import extension from "../../src/extension.ts";
import type { Forge } from "../../src/forge/types.ts";
import { getSession, setSession } from "../../src/hooks/session-store.ts";
import type { AccountRec } from "../forge/fake-gh/state.ts";
import { FakePi } from "../hooks/fake-pi.ts";
import { cleanupHomes, type Harness, harness, type HarnessOptions, ORIGIN_REMOTE } from "../hooks/helpers.ts";

const TTDUA: AccountRec = { login: "ttdua", token: "tok-ttdua", push: true };
const NAICOI: AccountRec = { login: "naicoi92", token: "tok-naicoi", push: false };
const NAICOI_WRITER: AccountRec = { ...NAICOI, push: true };

afterEach(async () => {
	setSession(undefined);
	await cleanupHomes();
});

function whoamiAs(login: string): HarnessOptions["forge"] {
	return (world) =>
		new Proxy(world.forge, {
			get(target, prop, receiver) {
				if (prop === "whoami") return async () => ({ login });
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as Forge;
}

/** `DoctorDeps` holding only the account fields; reading anything else (forge, files, content) throws. */
function accountOnlyDeps(account: ResolvedAccount | undefined, accountBlock?: string): DoctorDeps {
	const fields: Record<string, unknown> = { account, accountBlock };
	return new Proxy(fields, {
		get(target, prop) {
			if (prop === "account" || prop === "accountBlock") return target[prop];
			throw new Error(`the forge-account check must not read ${String(prop)}`);
		},
	}) as unknown as DoctorDeps;
}

function store(root: string, account: string): void {
	execFileSync("git", ["config", "--local", "livespec.account", account], { cwd: root });
	execFileSync("git", ["config", "--local", "livespec.accountRemote", ORIGIN_REMOTE], { cwd: root });
}

/** Runs `/livespec doctor` through the real extension, over the session the harness started. */
async function extensionDoctor(h: Harness): Promise<string> {
	const pi = new FakePi();
	extension(pi.api as never, { home: h.home, accounts: h.accounts, content: () => h.content.manager, detect: async () => h.world.forge });
	const ctx = { cwd: h.root, ui: { notify: vi.fn() }, isProjectTrusted: () => true, getSystemPromptOptions: () => ({ skills: [] }) };
	await pi.commands.get("livespec")?.handler("doctor", ctx);
	const reply = pi.sent.find((m) => m.customType === "livespec-doctor");
	if (!reply) throw new Error("no doctor reply");
	return reply.content;
}

const unverified: ResolvedAccount = {
	source: "stored",
	account: "ttdua",
	user: "ttdua",
	unverified: true,
	facts: {
		forge: "github",
		envToken: false,
		stored: { account: "ttdua", remote: ORIGIN_REMOTE },
		remote: ORIGIN_REMOTE,
		candidates: [
			{ candidate: { name: "ttdua", user: "ttdua" }, access: "unknown" },
			{ candidate: { name: "naicoi92", user: "naicoi92" }, access: "unknown" },
		],
		hasUI: false,
	},
};

describe("forge-account doctor check", () => {
	test("Doctor ok", async () => {
		const h = await harness({ accounts: [NAICOI, TTDUA], forge: whoamiAs("ttdua") });
		store(h.root, "ttdua");
		await h.start();
		const before = await readFile(join(h.root, ".git", "config"));

		const out = await extensionDoctor(h);

		expect(out).toContain(
			"ok forge-account: account ttdua, source stored; left out: naicoi92 (naicoi92): access unknown, not checked: the stored account can push",
		);
		expect(await readFile(join(h.root, ".git", "config"))).toEqual(before);
	});

	test("Doctor unverified", async () => {
		const results = await checkForgeAccount(accountOnlyDeps(unverified));

		expect(results).toEqual([
			{
				id: "forge-account",
				status: "warn",
				message: "account ttdua, source stored, unverified: the forge could not be reached to check its write access; left out: naicoi92 (naicoi92): access unknown, the check gave no answer",
				suggestion: "run /livespec doctor again once the forge is reachable",
			},
		]);
	});

	test("Doctor blocked", async () => {
		const h = await harness({ accounts: [NAICOI_WRITER, TTDUA], forge: whoamiAs("ttdua") });
		await h.start();
		const session = getSession();

		const results = await checkForgeAccount(accountOnlyDeps(session?.account, session?.accountBlock));

		expect(results).toEqual([
			{
				id: "forge-account",
				status: "error",
				message:
					"writes are refused: <untrusted>several accounts can push to github.com/acme/shop: naicoi92, ttdua; choose one with /livespec account &lt;name></untrusted>",
				suggestion: "run /livespec account <name> with one of: naicoi92, ttdua",
			},
		]);
	});

	test("doctor reads account state through command wiring", async () => {
		const h = await harness({ accounts: [NAICOI_WRITER, TTDUA], forge: whoamiAs("ttdua") });
		await h.start();

		const out = await extensionDoctor(h);

		expect(out).toContain("error forge-account: writes are refused: <untrusted>several accounts can push");
		expect(out).toContain("→ run /livespec account <name> with one of: naicoi92, ttdua");
	});

	test("an environment identity is reported untrusted with source environment", async () => {
		const env: ResolvedAccount = { ...unverified, source: "env", account: undefined, user: "bot</untrusted>", unverified: false };
		const results = await checkForgeAccount(accountOnlyDeps({ ...env, facts: { ...env.facts, envToken: true, candidates: [] } }));

		expect(results).toEqual([{ id: "forge-account", status: "ok", message: "account <untrusted>bot&lt;/untrusted></untrusted>, source environment; left out: none" }]);
	});

	test("without a resolution the check reports nothing", async () => {
		expect(await checkForgeAccount(accountOnlyDeps(undefined))).toEqual([]);
	});
});
