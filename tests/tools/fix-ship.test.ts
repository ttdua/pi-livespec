import { afterEach, describe, expect, test } from "vitest";
import { parseDecisionBlocks } from "../../src/decide/records.ts";
import type { PullRequest } from "../../src/forge/types.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { OTHER_LOGIN } from "../forge/world.ts";
import { asChild } from "../hooks/fake-pi.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, originRefs, textOf, type ToolHarness, type ToolHarnessOptions, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const NOTHING = "Nothing was pushed or opened.";
const SPEC = "# forge-read\n\n## Purpose\nRead.\n\n## Requirements\n\n### Requirement: Read cache\nThe system SHALL cache.\n\n#### Scenario: Fresh\n- **WHEN** a\n- **THEN** b\n";

const config = (testCommand: string | undefined): string => `integrationBranch: main\n${testCommand === undefined ? "" : `testCommand: ${JSON.stringify(testCommand)}\n`}`;

/** A harness on `fix/typo` with one README commit after `main`. */
async function fixReady(o: ToolHarnessOptions & { testCommand?: string | null } = {}): Promise<ToolHarness> {
	const { testCommand, ...rest } = o;
	const h = await toolHarness({ config: config(testCommand === null ? undefined : (testCommand ?? "true")), branch: "fix/typo", ...rest });
	await writeIn(h.root, "README.md", "fixed\n");
	commitAll(h.root, "Fix a typo in the README");
	return h;
}

const openPulls = (h: ToolHarness): Promise<PullRequest[]> => h.world.forge.listPullRequests({ state: "open", head: "fix/typo" });

async function refusedUnchanged(h: ToolHarness, text: string | undefined = undefined): Promise<string> {
	const before = originRefs(h.origin);
	const out = await h.call("fix_ship");
	expect(out.isError).toBe(true);
	expect(textOf(out)).toContain(NOTHING);
	if (text !== undefined) expect(textOf(out)).toContain(text);
	expect(originRefs(h.origin)).toBe(before);
	expect(out.details).toEqual({});
	return textOf(out);
}

describe("fix_ship", () => {
	test("Ship a small fix", async () => {
		const h = await fixReady();
		const out = await h.call("fix_ship");
		expect(out.isError, textOf(out)).toBeFalsy();
		const head = h.git("rev-parse", "HEAD");
		expect(originRefs(h.origin)).toContain(`${head} refs/heads/fix/typo`);
		const pulls = await openPulls(h);
		expect(pulls).toHaveLength(1);
		const pr = pulls[0] as PullRequest;
		expect(pr.base).toBe("main");
		expect(pr.title).toBe("Fix a typo in the README");
		expect(out.details).toEqual({ pr: pr.number });
		expect(textOf(out)).toContain(`#${pr.number}`);
		const records = parseDecisionBlocks(pr.body);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ point: "lane", subject: "typo", source: "rule", reason: "within the small-fix limits" });
		expect((records[0]?.outcome as { lane: string }).lane).toBe("small");
		expect(pr.body).toContain("## Test");
		expect(pr.body).toContain("exit 0");
		expect(pr.body).toContain(head.slice(0, 7));
	});

	test("forced reasons are wrapped as untrusted", async () => {
		const h = await fixReady({ files: { "specs/forge-read/spec.md": SPEC } });
		await writeIn(h.root, "specs/forge-read/spec.md", `${SPEC}\n### Requirement: Retry <b>budget</b>\nThe system SHALL retry.\n`);
		commitAll(h.root, "Add a retry budget");
		const text = await refusedUnchanged(h);
		expect(text).toContain("<untrusted>specs/forge-read/spec.md adds requirements Retry &lt;b>budget&lt;/b></untrusted>");
	});

	test("Forced fix refused", async () => {
		const h = await fixReady({ files: { "specs/forge-read/spec.md": SPEC } });
		await writeIn(h.root, "specs/forge-read/spec.md", `${SPEC}\n### Requirement: Retry budget\nThe system SHALL retry.\n`);
		commitAll(h.root, "Add a retry budget");
		const text = await refusedUnchanged(h, "Retry budget");
		expect(text).toContain("change_new <name> --from-fix");
		expect(await openPulls(h)).toHaveLength(0);
	});

	test("Failing tests", async () => {
		const h = await fixReady({ testCommand: "echo boom; exit 1" });
		const text = await refusedUnchanged(h, "exit 1");
		expect(text).toContain("boom");
		expect(await openPulls(h)).toHaveLength(0);
	});

	test("No test command", async () => {
		const h = await fixReady({ testCommand: null });
		const text = await refusedUnchanged(h, "testCommand");
		expect(text).toContain(".pi/livespec/config.yaml");
	});

	test("guard-blocked test command refuses", async () => {
		const h = await fixReady({ testCommand: "git push origin main" });
		await refusedUnchanged(h, "livespec guard:");
		expect(await openPulls(h)).toHaveLength(0);
	});

	test("a test command that commits is refused", async () => {
		const h = await fixReady({ testCommand: "git -c user.name=t -c user.email=t@t commit -q --allow-empty -m sneaky" });
		const head = h.git("rev-parse", "HEAD");
		await refusedUnchanged(h, "moved HEAD");
		expect(h.git("rev-parse", "HEAD~1")).toBe(head);
		expect(await openPulls(h)).toHaveLength(0);
	});

	test("a test command that dirties the tree is refused", async () => {
		const h = await fixReady({ testCommand: "echo x > README.md" });
		await refusedUnchanged(h, "uncommitted");
		expect(await openPulls(h)).toHaveLength(0);
	});

	test("a test command that switches the branch is refused", async () => {
		const h = await fixReady({ testCommand: "git switch -q main" });
		await refusedUnchanged(h, "switched the branch");
		expect(await openPulls(h)).toHaveLength(0);
	});

	test("Rerun updates the pull request", async () => {
		const h = await fixReady();
		const first = await h.call("fix_ship");
		expect(first.isError, textOf(first)).toBeFalsy();
		await writeIn(h.root, "README.md", "fixed again\n");
		commitAll(h.root, "Tidy the README");
		const head = h.git("rev-parse", "HEAD");
		const second = await h.call("fix_ship");
		expect(second.isError, textOf(second)).toBeFalsy();
		expect(second.details).toEqual(first.details);
		const pulls = await openPulls(h);
		expect(pulls).toHaveLength(1);
		expect(pulls[0]?.body).toContain(head.slice(0, 7));
		expect(pulls[0]?.body).toContain("- Tidy the README");
		expect(originRefs(h.origin)).toContain(`${head} refs/heads/fix/typo`);
	});

	test("Nothing to ship", async () => {
		const h = await toolHarness({ config: config("true"), branch: "fix/typo" });
		await refusedUnchanged(h, "nothing to ship");
	});

	test("Foreign pull request", async () => {
		const h = await fixReady();
		const other = await h.world.seedPullRequest({ head: "fix/typo", author: OTHER_LOGIN, body: "theirs" });
		await refusedUnchanged(h, `#${other}`);
		expect((await h.world.forge.getPullRequest(other)).body).toBe("theirs");
	});

	test("Lane decision in the pull request only", async () => {
		const h = await fixReady();
		const n = await h.world.seedIssue({ title: "other", body: "x", labels: ["livespec"] });
		const out = await h.call("fix_ship");
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(await h.world.forge.listComments(n)).toEqual([]);
	});

	test("a standalone pack without a lane config refuses, never throws", async () => {
		const h = await fixReady({ files: { ".pi/livespec/flow.yaml": "name: mine\nversion: 1\ncontent: c\nphases:\n  - id: one\n" } });
		const text = await refusedUnchanged(h, "decisions.lane");
		expect(text).not.toMatch(/Cannot read properties/);
		expect(await openPulls(h)).toHaveLength(0);
	});

	test("unknown integration branch refused", async () => {
		const h = await fixReady({ config: "testCommand: true\n" });
		await refusedUnchanged(h, "integration branch");
	});

	test("fetch failure refused", async () => {
		const h = await fixReady();
		h.git("remote", "remove", "origin");
		const out = await h.call("fix_ship");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(NOTHING);
		expect(await openPulls(h)).toHaveLength(0);
	});

	test("dirty tree refused", async () => {
		const h = await fixReady();
		await writeIn(h.root, "README.md", "dirty\n");
		await refusedUnchanged(h, "uncommitted");
	});

	test("not a fix branch refused", async () => {
		const h = await toolHarness({ config: config("true"), branch: "feature/x" });
		await refusedUnchanged(h, "fix/<slug>");
	});

	test("child session refused", async () => {
		const h = await fixReady();
		const before = originRefs(h.origin);
		const t = h.pi.tools.get("fix_ship");
		const out = (await t?.execute("c", {}, undefined, undefined, asChild(h.ctx))) as { isError?: boolean };
		expect(out.isError).toBe(true);
		expect(originRefs(h.origin)).toBe(before);
	});

	test("read-only forge refused", async () => {
		const h = await fixReady();
		await h.session.refresh();
		await h.world.makeUnreachable();
		await refusedUnchanged(h, "read-only");
		await h.world.restore();
	});

	test("update conflict says the branch was pushed", async () => {
		let conflict = false;
		const h = await fixReady({
			forge: (world) =>
				new Proxy(world.forge, {
					get(target, prop, receiver) {
						if (prop === "updatePullRequest" && conflict) return async () => ({ status: "conflict", current: "x", changed: ["body"] });
						return Reflect.get(target, prop, receiver);
					},
				}),
		});
		expect((await h.call("fix_ship")).isError).toBeFalsy();
		conflict = true;
		h.git("commit", "-q", "--allow-empty", "-m", "Second");
		const out = await h.call("fix_ship");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("was pushed");
		expect(textOf(out)).toContain("run fix_ship again");
		expect(originRefs(h.origin)).toContain(`${h.git("rev-parse", "HEAD")} refs/heads/fix/typo`);
	});

	test("create failure after the push says the branch was pushed", async () => {
		const h = await fixReady({
			forge: (world) =>
				new Proxy(world.forge, {
					get(target, prop, receiver) {
						if (prop === "createPullRequest") return async () => { throw new Error("forge down"); };
						return Reflect.get(target, prop, receiver);
					},
				}),
		});
		const out = await h.call("fix_ship");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("was pushed");
		expect(textOf(out)).toContain("run fix_ship again");
		expect(originRefs(h.origin)).toContain(`${h.git("rev-parse", "HEAD")} refs/heads/fix/typo`);
		expect(await openPulls(h)).toHaveLength(0);
	});
});
