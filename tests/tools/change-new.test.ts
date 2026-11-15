import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { cleanupDirs, textOf, toolHarness } from "./helpers.ts";

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
