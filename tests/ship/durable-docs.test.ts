import { describe, expect, test } from "vitest";
import { confirmationSection, durableDocsCheck } from "../../src/ship/durable-check.ts";
import { type DurableFacts, durableDocsRule, hardCovered } from "../../src/ship/durable-docs.ts";

const facts = (o: Partial<DurableFacts>): DurableFacts => ({
	files: [],
	added: [],
	capabilities: { new: [], modified: [] },
	specs: [],
	rows: [],
	behavior: [],
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

	test("a diff touching only specs/decisions needs no rows", () => {
		const r = durableDocsRule(facts({ files: ["specs/decisions/0001-x.md"], added: ["specs/decisions/0001-x.md"] }));
		expect(r).toEqual({ errors: [], confirm: [], needsRows: false });
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

	test("in ship, a missing context is an error, not a pass", async () => {
		const out = await durableDocsCheck({ root: "", change: {}, git: {}, marked: [], phase: "ship" } as never);
		expect(out).toEqual([{ code: "durable-docs", severity: "error", message: expect.stringContaining("no ship context") }]);
	});

	test("a refused ship context is an error naming the cause", async () => {
		const out = await durableDocsCheck({ root: "", change: {}, git: {}, marked: [], ship: { refused: "no integration branch" } } as never);
		expect(out).toEqual([{ code: "durable-docs", severity: "error", message: expect.stringContaining("no integration branch") }]);
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

describe("durableDocsRule behavior record", () => {
	const ROW = { file: "specs/rate-limit/spec.md", status: "not needed — refactor" };
	const CAP = "src/limit/cap.ts";
	const WIN = "src/limit/window.ts";

	test("Behavior answered earlier", () => {
		const f = facts({ files: [CAP], specs: [RATE], rows: [ROW], behavior: [{ capability: "rate-limit", files: [CAP], outcome: "unchanged" }] });
		const r = durableDocsRule(f);
		expect(r.confirm.some((c) => c.startsWith("rate-limit:"))).toBe(false);
		const text = confirmationSection({ ship: { durableFacts: f } } as never) ?? "";
		expect(text).toContain("not needed — refactor");
		expect(text).not.toContain("rate-limit: confirm");
	});

	test("Record misses a file", () => {
		const r = durableDocsRule(facts({ files: [CAP, WIN], specs: [RATE], rows: [ROW], behavior: [{ capability: "rate-limit", files: [CAP], outcome: "unchanged" }] }));
		expect(r.confirm).toHaveLength(1);
		expect(r.confirm[0]).toContain(CAP);
		expect(r.confirm[0]).toContain(WIN);
	});

	test("Newer changed record wins", () => {
		const r = durableDocsRule(facts({ files: [CAP], specs: [RATE], rows: [ROW], behavior: [{ capability: "rate-limit", files: [CAP], outcome: "changed" }] }));
		expect(r.confirm.some((c) => c.startsWith("rate-limit:"))).toBe(true);
	});

	test("Superset record", () => {
		const r = durableDocsRule(facts({ files: [CAP], specs: [RATE], rows: [ROW], behavior: [{ capability: "rate-limit", files: [CAP, WIN], outcome: "unchanged" }] }));
		expect(r.confirm).toEqual([]);
	});
});
