import { describe, expect, test } from "vitest";
import { confirmationSection, durableDocsCheck } from "../../src/ship/durable-check.ts";
import { type DurableFacts, durableDocsRule, hardCovered } from "../../src/ship/durable-docs.ts";

const facts = (o: Partial<DurableFacts>): DurableFacts => ({
	files: [],
	added: [],
	capabilities: { new: [], modified: [] },
	specs: [],
	rows: [],
	...o,
});

const RATE = { capability: "rate-limit", paths: ["src/limit/**"] };

describe("durableDocsRule", () => {
	test("Capability code without a spec row", () => {
		const r = durableDocsRule(
			facts({ files: ["src/limit/cap.ts"], specs: [RATE], rows: [{ file: "specs/rate-limit/spec.md", status: "not needed — refactor" }] }),
		);
		expect(r.errors).toEqual([]);
		expect(r.confirm).toHaveLength(1);
		expect(r.confirm[0]).toContain("rate-limit");
		expect(r.confirm[0]).toContain("src/limit/cap.ts");
		expect(r.needsRows).toBe(true);
	});

	test("an updated spec row clears the capability confirmation", () => {
		const r = durableDocsRule(
			facts({
				files: ["src/limit/cap.ts", "specs/rate-limit/spec.md"],
				specs: [RATE],
				rows: [{ file: "specs/rate-limit/spec.md", status: "updated" }],
			}),
		);
		expect(r).toMatchObject({ errors: [], confirm: [] });
	});

	test("Constraints without a decision", () => {
		const r = durableDocsRule(facts({ files: ["specs/constraints.md"], rows: [{ file: "specs/constraints.md", status: "updated" }] }));
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toContain("specs/decisions/");
	});

	test("Constraints with a decision", () => {
		const r = durableDocsRule(
			facts({
				files: ["specs/constraints.md", "specs/decisions/0007-cap.md"],
				added: ["specs/decisions/0007-cap.md"],
				rows: [{ file: "specs/constraints.md", status: "updated" }],
			}),
		);
		expect(r.errors).toEqual([]);
		expect(r.confirm).toHaveLength(1);
		expect(r.confirm[0]).toContain("specs/constraints.md");
		expect(r.confirm[0]).toContain("specs/decisions/0007-cap.md");
	});

	test("Changed durable doc without a row", () => {
		const r = durableDocsRule(facts({ files: ["specs/glossary.md"] }));
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toContain("specs/glossary.md");
	});

	test("a new capability without an updated product row is an error", () => {
		const r = durableDocsRule(facts({ capabilities: { new: ["cache"], modified: [] }, rows: [{ file: "specs/product.md", status: "not needed — small" }] }));
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toContain("specs/product.md");
		expect(r.needsRows).toBe(true);
	});

	test("a new capability with an updated product row passes", () => {
		const r = durableDocsRule(
			facts({ files: ["specs/product.md"], capabilities: { new: ["cache"], modified: [] }, rows: [{ file: "specs/product.md", status: "updated" }] }),
		);
		expect(r.errors).toEqual([]);
	});

	test("an updated row not in the diff is an error", () => {
		const r = durableDocsRule(facts({ rows: [{ file: "specs/glossary.md", status: "updated" }] }));
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toContain("specs/glossary.md");
	});

	test("Nothing durable touched", () => {
		const r = durableDocsRule(facts({ files: ["tests/fixture.json"], specs: [RATE] }));
		expect(r).toEqual({ errors: [], confirm: [], needsRows: false });
	});

	test("a changed decision file alone needs rows but no row for itself", () => {
		const r = durableDocsRule(facts({ files: ["specs/decisions/0001-x.md"], added: ["specs/decisions/0001-x.md"] }));
		expect(r).toEqual({ errors: [], confirm: [], needsRows: true });
	});
});

describe("hardCovered", () => {
	test("covers the product doc for a new capability and every changed spec doc", () => {
		const covered = hardCovered(facts({ files: ["specs/glossary.md", "specs/decisions/0001-x.md"], capabilities: { new: ["cache"], modified: [] } }));
		expect([...covered.keys()].sort()).toEqual(["specs/glossary.md", "specs/product.md"]);
		expect(covered.get("specs/product.md")).toContain("new capability");
	});
});

describe("durable-docs check and payload", () => {
	const ship = (f: DurableFacts) => ({ facts: f }) as never;
	const ctx = (f?: DurableFacts) => ({ root: "", change: {}, git: {}, marked: [], ...(f ? { ship: ship(f) } : {}) }) as never;

	test("outside ship (no context) it reports nothing", async () => {
		expect(await durableDocsCheck(ctx())).toEqual([]);
	});

	test("errors are errors and confirm items are warnings", async () => {
		const out = await durableDocsCheck(ctx(facts({ files: ["specs/glossary.md", "src/limit/cap.ts"], specs: [RATE] })));
		expect(out.map((r) => r.severity).sort()).toEqual(["error", "warning"]);
	});

	test("payload lists confirm items, reasons and decision files", () => {
		const f = facts({
			files: ["src/limit/cap.ts", "specs/constraints.md", "specs/decisions/0007-cap.md"],
			added: ["specs/decisions/0007-cap.md"],
			specs: [RATE],
			rows: [{ file: "specs/rate-limit/spec.md", status: "not needed — refactor" }, { file: "specs/constraints.md", status: "updated" }],
		});
		const text = confirmationSection({ ship: { durableFacts: f } } as never) ?? "";
		expect(text).toContain("Needs your confirmation:");
		expect(text).toContain("rate-limit");
		expect(text).toContain("not needed — refactor");
		expect(text).toContain("specs/decisions/0007-cap.md");
	});
});
