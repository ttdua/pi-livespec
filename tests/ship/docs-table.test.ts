import { describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { applyDocsTable, docsRowsRefusal, docsTableText } from "../../src/ship/docs-table.ts";
import type { DurableFacts } from "../../src/ship/durable-docs.ts";

const facts = (o: Partial<DurableFacts> = {}): DurableFacts => ({
	files: ["specs/rate-limit/spec.md"],
	added: [],
	capabilities: { new: [], modified: ["rate-limit"] },
	specs: [],
	rows: [],
	behavior: [],
	...o,
});

const BODY = "Base: abc\n\n## Proposal\nP\n\n## Units\n### U1 — t\n\n## Durable docs\n";

describe("docs table text", () => {
	test("rows round trip and leave the other sections byte for byte", () => {
		const rows = [
			{ file: "specs/rate-limit/spec.md", status: "updated" as const },
			{ file: "specs/glossary.md", status: "not needed" as const, reason: "no new term" },
		];
		const body = applyDocsTable(BODY, rows);
		expect(parseChange(body).durableDocs).toEqual([
			{ file: "specs/rate-limit/spec.md", status: "updated" },
			{ file: "specs/glossary.md", status: "not needed — no new term" },
		]);
		expect(body.startsWith(BODY.slice(0, BODY.indexOf("## Durable docs")))).toBe(true);
		expect(docsTableText(rows)).toContain("| specs/glossary.md | not needed — no new term |");
		expect(docsTableText(rows).split("\n").slice(0, 2)).toEqual(["| File | Status |", "| --- | --- |"]);
	});

	test("a second write replaces the rows", () => {
		const once = applyDocsTable(BODY, [{ file: "a.md", status: "updated" }]);
		const twice = applyDocsTable(once, [{ file: "b.md", status: "updated" }]);
		expect(parseChange(twice).durableDocs).toEqual([{ file: "b.md", status: "updated" }]);
	});
});

describe("docsRowsRefusal", () => {
	test("Updated row not in the diff", () => {
		const out = docsRowsRefusal([{ file: "specs/other/spec.md", status: "updated" }], facts());
		expect(out).toContain("specs/other/spec.md");
	});

	test("Not needed with a reason is accepted", () => {
		expect(docsRowsRefusal([{ file: "specs/glossary.md", status: "not needed", reason: "no new term" }], facts())).toBeUndefined();
	});

	test("Hard rule row", () => {
		const out = docsRowsRefusal([{ file: "specs/product.md", status: "not needed", reason: "small" }], facts({ capabilities: { new: ["cache"], modified: [] } }));
		expect(out).toContain("new capability");
	});

	test("an empty reason is refused", () => {
		expect(docsRowsRefusal([{ file: "specs/glossary.md", status: "not needed", reason: "  " }], facts())).toContain("reason");
		expect(docsRowsRefusal([{ file: "specs/glossary.md", status: "not needed" }], facts())).toContain("reason");
	});

	test("a cell with a pipe or a newline is refused", () => {
		expect(docsRowsRefusal([{ file: "a|b.md", status: "updated" }], facts({ files: ["a|b.md"] }))).toBeDefined();
		expect(docsRowsRefusal([{ file: "a.md", status: "not needed", reason: "x\ny" }], facts())).toBeDefined();
	});
});
