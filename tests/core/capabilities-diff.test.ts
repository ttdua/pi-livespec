import { describe, expect, it } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { capabilitiesMatchDiff } from "../../src/core/capabilities-diff.ts";

const change = (caps: string, base = "Base: abc\n") => parseChange(`${base}Capabilities: ${caps}\n\n## Units\n`);
const edit = (cap: string, file = "spec.md") =>
	`diff --git a/specs/${cap}/${file} b/specs/${cap}/${file}\nindex 1..2 100644\n--- a/specs/${cap}/${file}\n+++ b/specs/${cap}/${file}\n@@ -1 +1 @@\n`;
const create = (cap: string, file = "spec.md") =>
	`diff --git a/specs/${cap}/${file} b/specs/${cap}/${file}\nnew file mode 100644\nindex 0..2\n--- /dev/null\n+++ b/specs/${cap}/${file}\n@@ -0,0 +1 @@\n`;
const codes = (r: { code: string }[]) => r.map((x) => x.code);

describe("capabilities-diff.test", () => {
	it("declared but untouched", () => {
		const r = capabilitiesMatchDiff(change("new [], modified [rate-limit]"), "");
		expect(codes(r)).toEqual(["capabilities-match-diff"]);
		expect(r[0]?.severity).toBe("error");
		expect(r[0]?.message).toContain("rate-limit");
	});

	it("touched but undeclared", () => {
		const r = capabilitiesMatchDiff(change("new [], modified [rate-limit]"), edit("rate-limit") + edit("other"));
		expect(codes(r)).toEqual(["capabilities-match-diff"]);
		expect(r[0]?.message).toContain("other");
	});

	it("new must be created", () => {
		const r = capabilitiesMatchDiff(change("new [cache], modified []"), edit("cache"));
		expect(codes(r)).toEqual(["capabilities-match-diff"]);
		expect(r[0]?.message).toContain("cache");
	});

	it("new declared but untouched", () => {
		expect(codes(capabilitiesMatchDiff(change("new [cache], modified []"), ""))).toEqual(["capabilities-match-diff"]);
	});

	it("consistent diff", () => {
		const diff = edit("rate-limit") + create("cache") + edit("cache", "extra.md");
		expect(capabilitiesMatchDiff(change("new [cache], modified [rate-limit]"), diff)).toEqual([]);
	});

	it("top-level files and decisions are ignored", () => {
		const diff =
			edit("rate-limit") +
			"diff --git a/specs/glossary.md b/specs/glossary.md\n--- a/specs/glossary.md\n+++ b/specs/glossary.md\n" +
			"diff --git a/specs/decisions/0001-x.md b/specs/decisions/0001-x.md\nnew file mode 100644\n";
		expect(capabilitiesMatchDiff(change("new [], modified [rate-limit]"), diff)).toEqual([]);
	});

	it("not started", () => {
		const r = capabilitiesMatchDiff(change("new [], modified [rate-limit]", ""), "");
		expect(r).toHaveLength(1);
		expect(r[0]).toMatchObject({ code: "change-not-started", severity: "warning" });
	});
});

const rename = (from: string, to: string) =>
	`diff --git a/${from} b/${to}\nsimilarity index 90%\nrename from ${from}\nrename to ${to}\n`;

describe("capabilities-diff renames", () => {
	it("rename within one capability touches it without creating it", () => {
		const diff = rename("specs/rate-limit/a.md", "specs/rate-limit/b.md");
		expect(capabilitiesMatchDiff(change("new [], modified [rate-limit]"), diff)).toEqual([]);
	});

	it("rename across capabilities touches both and declares both", () => {
		const diff = rename("specs/cache/a.md", "specs/rate-limit/a.md");
		expect(capabilitiesMatchDiff(change("new [], modified [rate-limit]"), diff).map((x) => x.message)).toEqual([
			"Capability cache is touched by the diff but not declared",
		]);
		expect(capabilitiesMatchDiff(change("new [], modified [cache, rate-limit]"), diff)).toEqual([]);
	});

	it("rename into a new directory counts as created for a new capability", () => {
		const diff = rename("specs/glossary.md", "specs/cache/spec.md");
		expect(capabilitiesMatchDiff(change("new [cache], modified []"), diff)).toEqual([]);
	});

	it("rename into a new directory is an error when declared modified", () => {
		const diff = rename("specs/old/spec.md", "specs/cache/spec.md");
		const r = capabilitiesMatchDiff(change("new [], modified [cache]"), diff);
		expect(r.map((x) => x.message)).toEqual(["Capability old is touched by the diff but not declared"]);
	});

	it("paths with spaces and quoted names are attributed to their capability", () => {
		const diff = edit("rate limit", "my spec.md") + String.raw`diff --git "a/specs/caf\303\251/x.md" "b/specs/caf\303\251/x.md"` + "\n";
		const r = capabilitiesMatchDiff(change("new [], modified [rate limit, café]"), diff);
		expect(r).toEqual([]);
	});

	it("no state leak: a non-capability file after a capability edit adds nothing", () => {
		const diff = edit("rate-limit") + "diff --git a/README.md b/README.md\ndeleted file mode 100644\n";
		expect(capabilitiesMatchDiff(change("new [], modified [rate-limit]"), diff)).toEqual([]);
	});
});

describe("capabilities-diff not started section", () => {
	it("not started result is in the Capabilities section", () => {
		const r = capabilitiesMatchDiff(change("new [], modified [rate-limit]", ""), "");
		expect(r[0]?.section).toBe("Capabilities");
	});
});
