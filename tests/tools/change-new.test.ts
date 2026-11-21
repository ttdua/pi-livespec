import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const TEMPLATE = [
	"Depends: —",
	"Capabilities: new [], modified []",
	"Product impact: —",
	"",
	"## Proposal",
	"",
	"## Design",
	"",
	"## Questions",
	"",
	"## Units",
	"",
	"## Durable docs",
	"",
].join("\n");

const branches = (h: { git(...a: string[]): string }) => h.git("for-each-ref", "--format=%(refname)", "refs/heads");

describe("change_new", () => {
	test("Create change", async () => {
		const h = await toolHarness();
		const before = branches(h);
		const out = await h.call("change_new", { name: "rate-limit" });
		expect(out.isError).toBe(false);
		const issues = await h.world.forge.searchIssues({ state: "all" });
		expect(issues).toHaveLength(1);
		const [issue] = issues;
		expect(out.details).toEqual({ number: issue?.number });
		expect(issue?.title).toBe("rate-limit");
		expect(issue?.labels).toEqual(["livespec", "livespec:phase/shape"]);
		expect(issue?.body).toBe(TEMPLATE);
		const header = parseChange(issue?.body ?? "").header;
		expect(header.depends).toEqual([]);
		expect(header.capabilities).toEqual({ new: [], modified: [] });
		expect(header.productImpact).toBe("—");
		expect(branches(h)).toBe(before);
		expect(h.git("branch", "--show-current")).toBe("main");
		expect(textOf(out)).toContain(`#${issue?.number}`);
	});

	test("Duplicate name", async () => {
		const h = await toolHarness();
		await h.world.seedIssue({ title: "rate-limit", labels: ["livespec", "livespec:phase/define"] });
		const out = await h.call("change_new", { name: "rate-limit" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("rate-limit");
		expect(await h.world.forge.searchIssues({ state: "all" })).toHaveLength(1);
	});

	test("a name that is not kebab-case is refused", async () => {
		const h = await toolHarness();
		for (const name of ["Rate Limit", "-bad", "bad--name", ""]) {
			const out = await h.call("change_new", { name });
			expect(out.isError).toBe(true);
		}
		expect(await h.world.forge.searchIssues({ state: "all" })).toHaveLength(0);
	});

	test("a closed issue with the same title does not block", async () => {
		const h = await toolHarness();
		await h.world.seedIssue({ title: "rate-limit", labels: ["livespec"], state: "closed" });
		const out = await h.call("change_new", { name: "rate-limit" });
		expect(out.isError).toBe(false);
	});

	test("read-only forge refuses change_new", async () => {
		const h = await toolHarness();
		await h.session.refresh();
		await h.world.makeUnreachable();
		const out = await h.call("change_new", { name: "rate-limit" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("read-only");
		await h.world.restore();
		expect(await h.world.forge.searchIssues({ state: "all" })).toHaveLength(0);
	});
});

const SPEC = "# forge-read\n\n## Purpose\nRead.\n\n## Requirements\n\n### Requirement: Read cache\nThe system SHALL cache.\n\n#### Scenario: Fresh\n- **WHEN** a\n- **THEN** b\n";
const CONFIG = "integrationBranch: main\ntestCommand: \"true\"\n";

/** A harness on `fix/retry` with two commits, the second adding a requirement. */
async function forcedFix(): Promise<ToolHarness> {
	const h = await toolHarness({ config: CONFIG, branch: "fix/retry", files: { "specs/forge-read/spec.md": SPEC } });
	await writeIn(h.root, "README.md", "fixed\n");
	commitAll(h.root, "Fix a typo");
	await writeIn(h.root, "specs/forge-read/spec.md", `${SPEC}\n### Requirement: Retry budget\nThe system SHALL retry.\n`);
	commitAll(h.root, "Add a retry budget");
	return h;
}

const moveCall = (h: ToolHarness) => h.call("change_new", { name: "retry-budget", from_fix: true });
const noIssue = async (h: ToolHarness) => expect(await h.world.forge.searchIssues({ state: "all" })).toHaveLength(0);

describe("change_new from_fix", () => {
	test("Forced fix keeps its commits", async () => {
		const h = await forcedFix();
		const shipped = await h.call("fix_ship");
		expect(shipped.isError).toBe(true);
		expect(textOf(shipped)).toContain("change_new <name> --from-fix");
		const head = h.git("rev-parse", "HEAD");
		const base = h.git("merge-base", "HEAD", "origin/main");
		const out = await moveCall(h);
		expect(out.isError, textOf(out)).toBeFalsy();
		const [issue] = await h.world.forge.searchIssues({ state: "all" });
		expect(out.details).toEqual({ number: issue?.number, branch: "livespec/retry-budget" });
		expect(issue?.title).toBe("retry-budget");
		expect(issue?.labels).toEqual(["livespec", "livespec:phase/define"]);
		const parsed = parseChange(issue?.body ?? "");
		expect(parsed.header.branch).toBe("livespec/retry-budget");
		expect(parsed.header.base).toBe(base);
		expect(issue?.body).toContain("Moved from fix/retry:\n- Fix a typo\n- Add a retry budget\n");
		expect(h.git("branch", "--show-current")).toBe("livespec/retry-budget");
		expect(h.git("rev-parse", "HEAD")).toBe(head);
		expect(h.git("branch", "--list", "fix/retry")).toBe("");
		expect(h.git("config", "branch.livespec/retry-budget.livespecBase")).toBe(base);
		await h.session.refresh(); // the card is built by buildCardInput on every refresh
		const card = h.session.card;
		expect(card.kind).toBe("change");
		if (card.kind === "change") expect(card.state.phase).toEqual({ kind: "ok", id: "define" });
	});

	test("Open fix pull request", async () => {
		const h = await forcedFix();
		const n = await h.world.seedPullRequest({ head: "fix/retry" });
		const out = await moveCall(h);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(`#${n}`);
		await noIssue(h);
		expect(h.git("branch", "--show-current")).toBe("fix/retry");
	});

	test("Not on a fix branch", async () => {
		const h = await toolHarness({ config: CONFIG });
		const out = await moveCall(h);
		expect(out.isError).toBe(true);
		await noIssue(h);
	});

	test("an existing livespec branch is refused", async () => {
		const h = await forcedFix();
		h.git("branch", "livespec/retry-budget");
		const out = await moveCall(h);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("livespec/retry-budget");
		await noIssue(h);
	});

	test("a dirty tree is refused", async () => {
		const h = await forcedFix();
		await writeIn(h.root, "README.md", "dirty\n");
		const out = await moveCall(h);
		expect(out.isError).toBe(true);
		await noIssue(h);
	});

	test("read-only forge refused on a fix branch", async () => {
		const h = await forcedFix();
		await h.session.refresh();
		await h.world.makeUnreachable();
		const out = await moveCall(h);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("read-only");
		await h.world.restore();
		await noIssue(h);
		expect(h.git("branch", "--show-current")).toBe("fix/retry");
	});

	test("fetch failure refused", async () => {
		const h = await forcedFix();
		h.git("remote", "remove", "origin");
		const out = await moveCall(h);
		expect(out.isError).toBe(true);
		await noIssue(h);
		expect(h.git("branch", "--show-current")).toBe("fix/retry");
	});

	test("an invalid name is refused", async () => {
		const h = await forcedFix();
		const out = await h.call("change_new", { name: "Bad Name", from_fix: true });
		expect(out.isError).toBe(true);
		await noIssue(h);
	});
});

describe("change_new from_fix failure after the issue exists", () => {
	test("a failed rename names the issue and the remaining commands", async () => {
		const h = await forcedFix();
		const base = h.git("merge-base", "HEAD", "origin/main");
		mkdirSync(join(h.root, ".git/refs/heads/livespec"), { recursive: true });
		writeFileSync(join(h.root, ".git/refs/heads/livespec/retry-budget.lock"), "");
		const out = await moveCall(h);
		expect(out.isError).toBe(true);
		const [issue] = await h.world.forge.searchIssues({ state: "all" });
		expect(issue?.title).toBe("retry-budget");
		expect(textOf(out)).toContain(`#${issue?.number}`);
		expect(textOf(out)).toContain("git branch -m fix/retry livespec/retry-budget");
		expect(textOf(out)).toContain(`git config branch.livespec/retry-budget.livespecBase ${base}`);
		expect(h.git("branch", "--show-current")).toBe("fix/retry");
	});

	test("a failed config write names the issue and the config command", async () => {
		const h = await forcedFix();
		const base = h.git("merge-base", "HEAD", "origin/main");
		const git = h.session.git;
		Object.assign(h.session, { git: { ...git, configSet: async () => { throw new Error("config locked"); } } });
		const out = await moveCall(h);
		expect(out.isError).toBe(true);
		const [issue] = await h.world.forge.searchIssues({ state: "all" });
		expect(textOf(out)).toContain(`#${issue?.number}`);
		expect(textOf(out)).toContain(`git config branch.livespec/retry-budget.livespecBase ${base}`);
		expect(textOf(out)).not.toContain("git branch -m");
		expect(h.git("branch", "--show-current")).toBe("livespec/retry-budget");
	});
});
