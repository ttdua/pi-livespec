import { afterEach, describe, expect, test } from "vitest";
import { setSession } from "../../src/hooks/session-store.ts";
import { asChild } from "../hooks/fake-pi.ts";
import { writeIn } from "../helpers/repo.ts";
import { cleanupDirs, originRefs, textOf, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const hasRef = (git: (...a: string[]) => string, name: string) => git("branch", "--list", name) !== "";

describe("fix_start", () => {
	test("Start a fix", async () => {
		const h = await toolHarness();
		const before = originRefs(h.origin);
		const out = await h.call("fix_start", { slug: "typo-in-readme" });
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(h.git("branch", "--show-current")).toBe("fix/typo-in-readme");
		expect(h.git("rev-parse", "HEAD")).toBe(h.head);
		expect(out.details).toEqual({ branch: "fix/typo-in-readme" });
		expect(textOf(out)).toBe(`Started fix/typo-in-readme at origin/main ${h.head}. No issue was created and nothing was pushed.`);
		expect(await h.world.forge.searchIssues({})).toEqual([]);
		expect(originRefs(h.origin)).toBe(before);
	});

	test("Dirty tree", async () => {
		const h = await toolHarness();
		await writeIn(h.root, "README.md", "changed\n");
		const out = await h.call("fix_start", { slug: "typo" });
		expect(out.isError).toBe(true);
		expect(hasRef(h.git, "fix/typo")).toBe(false);
		expect(h.git("branch", "--show-current")).toBe("main");
	});

	test("From a change branch", async () => {
		const h = await toolHarness({ branch: "livespec/rate-limit" });
		const out = await h.call("fix_start", { slug: "typo" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("livespec/rate-limit");
		expect(hasRef(h.git, "fix/typo")).toBe(false);
	});

	test("Slug is not kebab-case", async () => {
		const h = await toolHarness();
		for (const slug of ["Typo", "a_b", "a/b", "", "-a"]) {
			const out = await h.call("fix_start", { slug });
			expect(out.isError, slug).toBe(true);
		}
		expect(h.git("branch", "--list", "fix/*")).toBe("");
	});

	test("Existing fix branch", async () => {
		const h = await toolHarness({ prepare: (git) => git("branch", "fix/typo") });
		const out = await h.call("fix_start", { slug: "typo" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("fix/typo");
		expect(h.git("branch", "--show-current")).toBe("main");
	});

	test("Unknown integration branch", async () => {
		const h = await toolHarness({ config: "{}\n" });
		const out = await h.call("fix_start", { slug: "typo" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("integration branch is unknown");
		expect(hasRef(h.git, "fix/typo")).toBe(false);
	});

	test("Fetch fails", async () => {
		const h = await toolHarness();
		h.git("remote", "set-url", "origin", `${h.origin}-missing`);
		const out = await h.call("fix_start", { slug: "typo" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("fix_start refused: git failed:");
		expect(hasRef(h.git, "fix/typo")).toBe(false);
		expect(h.git("branch", "--show-current")).toBe("main");
	});

	test("Child session", async () => {
		const h = await toolHarness();
		const t = h.pi.tools.get("fix_start");
		const out = (await t?.execute("c", { slug: "typo" }, undefined, undefined, asChild(h.ctx))) as { isError?: boolean };
		expect(out.isError).toBe(true);
		expect(hasRef(h.git, "fix/typo")).toBe(false);
	});
});
