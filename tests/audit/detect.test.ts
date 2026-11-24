// drift-audit "Drift detectors".

import { describe, expect, test } from "vitest";
import { detectDocs } from "../../src/audit/detect-docs.ts";
import { detectFixes } from "../../src/audit/detect-fixes.ts";
import { detectSpecs, isIdentifierToken, isPathToken } from "../../src/audit/detect-specs.ts";
import { pullRequestOf } from "../../src/audit/items.ts";
import { memoryView, repoViewAt } from "../../src/audit/repo-view.ts";
import { forgeOf, laneBody, pullRequest, seededFiles, seededFixes } from "./seeded.ts";

async function detectAll(files: Record<string, string>): Promise<string[]> {
	const view = memoryView(files);
	return [...(await detectSpecs(view)), ...(await detectDocs(view))].map((i) => i.key);
}

describe("Drift detectors", () => {
	test("Seeded repository", async () => {
		const view = memoryView(seededFiles());
		const { commits, forge } = seededFixes();
		const items = [...(await detectSpecs(view)), ...(await detectDocs(view)), ...(await detectFixes(commits, forge))];
		expect(items.map((i) => i.key).sort()).toEqual(
			[
				"scenario-untested:rate-limit/rejects 101st request",
				"removed-reference:rate-limit/src/limit/old.ts",
				"dead-paths:rate-limit:src/gone/**",
				"unused-term:Bucket",
				"stale-decision:0002-x@specs/product.md",
				"product-missing:cache",
				"declared-none:pr#7:rate-limit",
			].sort(),
		);
		for (const item of items) {
			expect(item.key).toBe(`${item.type}:${item.subject}`);
			expect(item.evidence).not.toBe("");
		}
		const capabilities = Object.fromEntries(items.map((i) => [i.type, i.capability]));
		expect(capabilities).toEqual({
			"scenario-untested": "rate-limit",
			"removed-reference": "rate-limit",
			"dead-paths": "rate-limit",
			"unused-term": undefined,
			"stale-decision": undefined,
			"product-missing": "cache",
			"declared-none": "rate-limit",
		});
	});

	test("Tested scenario", async () => {
		const files = { ...seededFiles(), "tests/limit.test.ts": 'it("Rejects 101st request", () => {});\nit("allows 100 requests", () => {});\n' };
		expect((await detectAll(files)).filter((k) => k.startsWith("scenario-untested:"))).toEqual([]);
	});

	test("scenario named only in a spec or a non-test file is untested", async () => {
		const files = { ...seededFiles(), "src/limit/notes.md": "rejects 101st request\n" };
		expect(await detectAll(files)).toContain("scenario-untested:rate-limit/rejects 101st request");
	});

	test("Superseded decision mentioned as superseded", async () => {
		const files = { ...seededFiles(), "specs/product.md": "# Product\n\nrate-limit and cache.\n0002-x is superseded by 0005-y\n" };
		expect((await detectAll(files)).filter((k) => k.startsWith("stale-decision:"))).toEqual([]);
	});

	test("decisions/NNNN- reference is stale; the decision file itself is not", async () => {
		const files = { ...seededFiles(), "specs/cache/spec.md": `${seededFiles()["specs/cache/spec.md"]}\nSee decisions/0002-x.md.\n` };
		const keys = await detectAll(files);
		expect(keys).toContain("stale-decision:0002-x@specs/cache/spec.md");
		expect(keys.filter((k) => k.endsWith("@specs/decisions/0002-x.md"))).toEqual([]);
	});

	test("glob token ignored", async () => {
		const keys = await detectAll(seededFiles());
		expect(keys.filter((k) => k.includes("src/limit/**"))).toEqual([]);
	});

	test("identifier used outside specs is not removed; one used nowhere is", async () => {
		const files = { ...seededFiles(), "src/limit/cap.ts": "export class Other {}\n" };
		expect(await detectAll(files)).toContain("removed-reference:rate-limit/RateLimiter");
		expect(await detectAll(seededFiles())).not.toContain("removed-reference:rate-limit/RateLimiter");
	});

	test("empty repo view yields no items", async () => {
		expect(await detectAll({})).toEqual([]);
		const template = { "specs/product.md": "# Product\n\n<!-- describe the product -->\n", "specs/glossary.md": "# Glossary\n" };
		expect(await detectAll(template)).toEqual([]);
		expect(await detectFixes([], forgeOf([]))).toEqual([]);
	});

	test("repoViewAt reads the commit through git", async () => {
		const files: Record<string, string> = { "a.ts": "x", "specs/glossary.md": "g" };
		const reads: string[] = [];
		const git = {
			listTree: async (rev: string) => (rev === "c1" ? Object.keys(files) : []),
			showFile: async (rev: string, path: string) => {
				reads.push(`${rev}:${path}`);
				return files[path];
			},
		};
		const view = await repoViewAt(git, "c1");
		expect(view.commit).toBe("c1");
		expect(view.files).toEqual(["a.ts", "specs/glossary.md"]);
		expect(await view.read("a.ts")).toBe("x");
		expect(await view.read("a.ts")).toBe("x");
		expect(reads).toEqual(["c1:a.ts"]);
	});
});

describe("declared-none", () => {
	test("commit whose pull request head is livespec/x yields no item", async () => {
		const forge = forgeOf([pullRequest(9, "livespec/x", laneBody(["rate-limit"]))]);
		expect(await detectFixes([{ sha: "b".repeat(40), subject: "feat: x (#9)" }], forge)).toEqual([]);
	});

	test("commit naming no pull request is not read", async () => {
		const forge = forgeOf([]);
		expect(await detectFixes([{ sha: "c".repeat(40), subject: "tweak limits" }], forge)).toEqual([]);
	});

	test("lane block without declared-none yields no item", async () => {
		const body = laneBody(["rate-limit"]).replace("behavior_change: declared-none\n", "");
		const forge = forgeOf([pullRequest(8, "fix/y", body)]);
		expect(await detectFixes([{ sha: "d".repeat(40), subject: "Merge pull request #8 from a/fix/y" }], forge)).toEqual([]);
	});

	test("one item per listed capability", async () => {
		const forge = forgeOf([pullRequest(8, "fix/y", laneBody(["rate-limit", "cache"]))]);
		const items = await detectFixes([{ sha: "d".repeat(40), subject: "Merge pull request #8 from a/fix/y" }], forge);
		expect(items.map((i) => i.key)).toEqual(["declared-none:pr#8:rate-limit", "declared-none:pr#8:cache"]);
	});

	test("a forge read error propagates", async () => {
		await expect(detectFixes([{ sha: "e".repeat(40), subject: "fix (#404)" }], forgeOf([]))).rejects.toThrow("#404");
	});
});

describe("pullRequestOf", () => {
	test("reads the pull request number of a subject", () => {
		expect(pullRequestOf("feat: cap (#41)")).toBe(41);
		expect(pullRequestOf("Merge pull request #12 from x/y")).toBe(12);
		expect(pullRequestOf("tweak limits")).toBeUndefined();
	});
});

describe("tokens", () => {
	test("isIdentifierToken", () => {
		for (const t of ["rateLimit", "RateLimiter", "Change", "Bucket", "URLParser", "rate_limit"]) expect(isIdentifierToken(t), t).toBe(true);
		for (const t of ["abc", "API", "the", "a.b"]) expect(isIdentifierToken(t), t).toBe(false);
	});

	test("isPathToken", () => {
		expect(isPathToken("src/limit/old.ts")).toBe(true);
		expect(isPathToken("src/**")).toBe(false);
	});
});
