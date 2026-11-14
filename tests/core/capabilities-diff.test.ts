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
