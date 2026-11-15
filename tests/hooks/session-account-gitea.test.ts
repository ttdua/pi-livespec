// Account resolution at session start against a Gitea: the loopback fake
// Gitea over real HTTP, a temp `tea` config with two logins for its host and
// the real forge detection. A refused selection must keep reads working.

import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import type { GitExec } from "../../src/engine/git-exec.ts";
import type { Session } from "../../src/hooks/session.ts";
import { getSession, setSession } from "../../src/hooks/session-store.ts";
import { FakeGitea, type FakeGiteaAccount } from "../forge/fake-gitea.ts";
import { BUILD_LABELS, CHANGE_BRANCH, cardText, cleanupHomes, harness, type HarnessOptions, resumeBody, type ToolOut } from "./helpers.ts";

const ADMIN: FakeGiteaAccount = { token: "tok-gitea-admin", login: "admin", push: true };
const BOT: FakeGiteaAccount = { token: "tok-gitea-bot", login: "livespec-bot", push: true };

const fakes: FakeGitea[] = [];
afterEach(async () => {
	setSession(undefined);
	await cleanupHomes();
	for (const fake of fakes.splice(0)) await fake.close();
});

function current(): Session {
	const session = getSession();
	if (!session) throw new Error("no session");
	return session;
}

const text = (out: ToolOut) => out.content.map((c) => c.text).join("\n");

/** A `tea` login entry for `url`; `user` is left out when empty. */
function teaLogin(name: string, url: string, account: FakeGiteaAccount, user = account.login): string {
	return `  - name: ${name}\n    url: ${url}\n    token: ${account.token}\n${user === "" ? "" : `    user: ${user}\n`}`;
}

async function giteaFake(accounts: FakeGiteaAccount[]): Promise<FakeGitea> {
	const fake = await FakeGitea.start({ owner: "acme", repo: "shop", accounts });
	fakes.push(fake);
	return fake;
}

/** Two writable `tea` logins for the fake: the selection is ambiguous. */
async function twoWriters(o: Partial<HarnessOptions> = {}) {
	const fake = await giteaFake([ADMIN, BOT]);
	const teaConfig = `logins:\n${teaLogin("gitea-admin", fake.url, ADMIN)}${teaLogin("gitea-bot", fake.url, BOT)}`;
	const h = await harness({ branch: CHANGE_BRANCH, gitea: { url: fake.url, teaConfig }, ...o });
	const n = fake.seedIssue({ title: "per-ip-cap", body: resumeBody("x"), labels: BUILD_LABELS });
	return { fake, h, n };
}

describe("Gitea: reads keep working while the account blocks writes", () => {
	test("Refusal blocks writes", async () => {
		const { fake, h, n } = await twoWriters();
		await h.start();
		const block = current().accountBlock;
		expect(block).toContain("gitea-admin");
		expect(block).toContain("gitea-bot");
		expect(current().account?.readOnlyLogin).toBe("gitea-admin");

		const status = await h.call("spec_status");
		expect(status.isError, text(status)).toBe(false);
		expect(text(status)).toContain(`#${n}`);
		expect(current().card.kind).toBe("change");
		expect(current().card.account).toEqual({ blocked: block });

		const created = await h.call("change_new", { name: "rate-limit" });
		expect(created.isError).toBe(true);
		expect(text(created)).toContain(block as string);
		expect(fake.calls.filter((c) => c.method !== "GET")).toEqual([]);
	});

	test("Cancelled", async () => {
		const { fake, h, n } = await twoWriters({ hasUI: true, select: async () => undefined });
		await h.start();
		expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
		const block = current().accountBlock;
		expect(block).toContain("/livespec account <name>");

		const status = await h.call("spec_status");
		expect(status.isError, text(status)).toBe(false);
		expect(text(status)).toContain(`#${n}`);

		const created = await h.call("change_new", { name: "rate-limit" });
		expect(created.isError).toBe(true);
		expect(text(created)).toContain(block as string);
		expect(fake.calls.filter((c) => c.method !== "GET")).toEqual([]);
	});

	test("a forge error echoing the read-only login's token is redacted", async () => {
		const { fake, h } = await twoWriters();
		fake.echoTokenOnRead(/\/issues/);
		await h.start();
		const session = current();
		expect(session.account?.readOnlyLogin).toBe("gitea-admin");

		const status = await h.call("spec_status");
		const card = await cardText(h.pi, h.ctx);
		const created = await h.call("change_new", { name: "rate-limit" });

		// Positive control: the forge error reaches the user, with the token replaced.
		expect(session.errors.join("\n")).toContain("upstream rejected credentials ***");
		expect(card).toContain("upstream rejected credentials ***");
		const values = [session.errors.join("\n"), session.forgeError ?? "", JSON.stringify(session.card), card, text(status), JSON.stringify(status.details)];
		for (const value of values) expect(value).not.toContain(ADMIN.token);
		expect(created.isError).toBe(true);
		expect(fake.calls.filter((c) => c.method !== "GET")).toEqual([]);
	});

	test("a forge error echoing GITEA_TOKEN is redacted when the selection fails", async () => {
		const ENV: FakeGiteaAccount = { token: "tok-gitea-env", login: "env-bot", push: true };
		const fake = await giteaFake([ENV, ADMIN]);
		const teaConfig = `logins:\n${teaLogin("gitea-admin", fake.url, ADMIN)}`;
		const failStoredRead = (real: GitExec): GitExec => async (args, opts) =>
			args.includes("--get") ? { code: 3, stdout: "", stderr: "fatal: bad config file" } : real(args, opts);
		const h = await harness({ branch: CHANGE_BRANCH, gitea: { url: fake.url, teaConfig }, accountEnv: { GITEA_TOKEN: ENV.token }, accountGit: failStoredRead });
		fake.seedIssue({ title: "per-ip-cap", body: resumeBody("x"), labels: BUILD_LABELS });
		fake.echoTokenOnRead(/\/issues/);
		await h.start();
		const session = current();
		expect(session.accountBlock).toContain("account selection failed");
		expect(session.account?.token).toBeUndefined();

		const status = await h.call("spec_status");
		const card = await cardText(h.pi, h.ctx);
		const created = await h.call("change_new", { name: "rate-limit" });

		// Positive control: the adapter did send GITEA_TOKEN, and its echo reaches the user redacted.
		expect(fake.calls.some((c) => c.authorization === `token ${ENV.token}`)).toBe(true);
		expect(session.errors.join("\n")).toContain("upstream rejected credentials ***");
		expect(card).toContain("upstream rejected credentials ***");
		const values = [session.errors.join("\n"), session.forgeError ?? "", JSON.stringify(session.card), card, text(status), JSON.stringify(status.details)];
		for (const value of values) expect(value).not.toContain(ENV.token);
		expect(created.isError).toBe(true);
		expect(fake.calls.filter((c) => c.method !== "GET")).toEqual([]);
	});

	test("a stored account that is still a candidate is the read-only login", async () => {
		const DENIED: FakeGiteaAccount = { token: "tok-gitea-denied", login: "denied", push: false };
		const fake = await giteaFake([DENIED, ADMIN, BOT]);
		const teaConfig = `logins:\n${teaLogin("gitea-admin", fake.url, ADMIN)}${teaLogin("gitea-bot", fake.url, BOT)}${teaLogin("gitea-denied", fake.url, DENIED)}`;
		const h = await harness({ branch: CHANGE_BRANCH, gitea: { url: fake.url, teaConfig } });
		// Stored for this remote, but it lost write access: the two writers make the selection ambiguous.
		execFileSync("git", ["config", "--local", "livespec.account", "gitea-denied"], { cwd: h.root });
		execFileSync("git", ["config", "--local", "livespec.accountRemote", `${new URL(fake.url).host}/acme/shop`], { cwd: h.root });

		await h.start();

		expect(current().accountBlock).toContain("gitea-bot");
		expect(current().account?.readOnlyLogin).toBe("gitea-denied");
		expect((await h.call("spec_status")).isError).toBe(false);
		expect((await h.call("change_new", { name: "rate-limit" })).isError).toBe(true);
	});

	test("a candidate denied by the forge is never the read-only login", async () => {
		const DENIED: FakeGiteaAccount = { token: "tok-gitea-denied", login: "denied", push: false };
		const fake = await giteaFake([DENIED, ADMIN, BOT]);
		const teaConfig = `logins:\n${teaLogin("gitea-denied", fake.url, DENIED)}${teaLogin("gitea-admin", fake.url, ADMIN)}${teaLogin("gitea-bot", fake.url, BOT)}`;
		const h = await harness({ branch: CHANGE_BRANCH, gitea: { url: fake.url, teaConfig } });

		await h.start();

		expect(current().accountBlock).toBeDefined();
		expect(current().account?.readOnlyLogin).toBe("gitea-admin");
	});

	test("a candidate without user is confirmed by whoami and records the login", async () => {
		const fake = await giteaFake([ADMIN]);
		const teaConfig = `logins:\n${teaLogin("gitea-admin", fake.url, ADMIN, "")}`;
		const h = await harness({ branch: CHANGE_BRANCH, gitea: { url: fake.url, teaConfig } });

		await h.start();

		expect(current().accountBlock).toBeUndefined();
		expect(current().account).toMatchObject({ account: "gitea-admin", user: "admin" });
		const created = await h.call("change_new", { name: "rate-limit" });
		expect(created.isError, text(created)).toBe(false);
	});
});
