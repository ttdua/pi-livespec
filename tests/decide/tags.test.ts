import { describe, expect, test } from "vitest";
import { type TagsConfig, type TagsFacts, tagsRule, tagsSchema } from "../../src/decide/rules/tags.ts";

const CONFIG: TagsConfig = {
	mode: "rule",
	paths: {
		security: ["**/auth/**", "**/middleware/**"],
		migration: ["**/migrations/**"],
		ui: ["**/*.tsx", "**/*.jsx", "**/*.css", "**/*.vue", "**/*.svelte"],
		api: ["**/api/**", "**/routes/**"],
	},
	keywords: {
		security: ["auth", "token", "password", "session", "permission", "secret"],
		migration: ["migration", "schema"],
		perf: ["performance", "latency", "throughput", "cache"],
		api: ["endpoint", "public api"],
	},
};

function facts(over: Partial<TagsFacts>): TagsFacts {
	return { title: "Unit", covers: [], files: [], doneMeans: [], extraTags: [], ...over };
}

function run(over: Partial<TagsFacts>, config: TagsConfig = CONFIG) {
	const r = tagsRule(facts(over), config);
	if (!("outcome" in r)) throw new Error("tags never asks");
	return r;
}

describe("tags rule", () => {
	test("Path match", () => {
		expect(run({ files: ["db/migrations/0003.sql"] }).outcome).toEqual(["migration"]);
	});

	test("Keyword whole word", () => {
		const r = run({ doneMeans: ["store the author name"] });
		expect(r.outcome).not.toContain("security");
		expect(r.outcome).toEqual([]);
	});

	test("Keyword phrase ignoring case", () => {
		expect(run({ title: "Document the Public API" }).outcome).toEqual(["api"]);
	});

	test("keyword phrase matches across any whitespace", () => {
		expect(run({ covers: ["docs/Requirement: public\tapi"] }).outcome).toEqual(["api"]);
	});

	test("extra tags are appended once and reported as agent additions", () => {
		const r = run({ files: ["src/auth/login.ts"], extraTags: ["api", "security", "api"] });
		expect(r.outcome).toEqual(["security", "api"]);
		expect(r.data?.agentAdditions).toEqual(["api"]);
	});

	test("tags follow config order", () => {
		const r = run({ title: "Cache the endpoint", files: ["web/Button.tsx", "src/auth/x.ts"] });
		expect(r.outcome).toEqual(["security", "ui", "api", "perf"]);
	});

	test("extra tag that is not kebab-case is refused", () => {
		expect(() => run({ extraTags: ["Critical Path"] })).toThrow(/kebab-case/);
	});

	test("reason names the matched facts", () => {
		const r = run({ files: ["db/migrations/0003.sql"] });
		expect(r.reason).toContain("migration");
		expect(r.reason).toContain("db/migrations/0003.sql");
	});
});

describe("tags merge", () => {
	test("Override adds globs", () => {
		const merged = tagsSchema.merge?.(CONFIG, { paths: { security: ["**/crypto/**", "**/auth/**"], infra: ["ops/**"] } }) as TagsConfig;
		expect(merged.paths.security).toEqual(["**/auth/**", "**/middleware/**", "**/crypto/**"]);
		expect(merged.paths.infra).toEqual(["ops/**"]);
		expect(merged.keywords).toEqual(CONFIG.keywords);
		expect(merged.mode).toBe("rule");
	});
});
