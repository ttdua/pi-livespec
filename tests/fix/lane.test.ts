import { LineCounter, isMap, parseDocument } from "yaml";
import { describe, expect, test } from "vitest";
import type { LaneFacts } from "../../src/fix/lane-facts.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { type LaneConfig, laneConfigOf, laneRule, laneRuleFn, laneSchema } from "../../src/fix/lane.ts";

const CONFIG: LaneConfig = { mode: "rule", max_files: 3, max_lines: 100 };

function facts(over: Partial<LaneFacts> = {}): LaneFacts {
	return {
		files: ["src/forge/read.ts", "specs/forge-read/spec.md"],
		lines: 12,
		spec_changes: [{ capability: "forge-read", added_requirements: [], removed_requirements: [], scenarios: [] }],
		created_capabilities: [],
		governance: [],
		capability_code: [{ capability: "forge-read", files: ["src/forge/read.ts"], spec_changed: true }],
		...over,
	};
}

const one = (f: LaneFacts) => {
	const o = laneRule(f, CONFIG);
	expect(o.lane).toBe("forced");
	expect(o.reasons).toHaveLength(1);
	return o.reasons[0] ?? "";
};

describe("laneRule", () => {
	test("Small fix", () => {
		expect(laneRule(facts(), CONFIG)).toEqual({ lane: "small", reasons: [] });
	});

	test("Added requirement forces", () => {
		const r = one(facts({ spec_changes: [{ capability: "forge-read", added_requirements: ["Retry budget"], removed_requirements: [], scenarios: [] }] }));
		expect(r).toContain("forge-read");
		expect(r).toContain("Retry budget");
	});

	test("Removed requirement forces", () => {
		const r = one(facts({ spec_changes: [{ capability: "forge-read", added_requirements: [], removed_requirements: ["Cache"], scenarios: [] }] }));
		expect(r).toContain("Cache");
	});

	test("Removed scenario forces", () => {
		const r = one(
			facts({ spec_changes: [{ capability: "forge-read", added_requirements: [], removed_requirements: [], scenarios: [{ requirement: "Read cache", added: [], removed: ["Stale cache"] }] }] }),
		);
		expect(r).toContain("Read cache");
		expect(r).toContain("Stale cache");
	});

	test("Too many files", () => {
		const r = one(facts({ files: ["a", "b", "c", "d"] }));
		expect(r).toContain("max_files");
		expect(r).toContain("3");
	});

	test("Too many lines", () => {
		const r = one(facts({ files: ["a.ts"], lines: 101 }));
		expect(r).toContain("max_lines");
		expect(r).toContain("100");
	});

	test("limits are inclusive", () => {
		expect(laneRule(facts({ files: ["a", "b", "c"], lines: 100 }), CONFIG).lane).toBe("small");
	});

	test("a rename counts once", () => {
		// numstat reports one entry with the new path, so `files` holds it once.
		expect(laneRule(facts({ files: ["a", "b", "renamed.ts"] }), CONFIG).lane).toBe("small");
	});

	test("New capability", () => {
		expect(one(facts({ created_capabilities: ["retry-policy"] }))).toContain("retry-policy");
	});

	test("Governance files", () => {
		const r = one(facts({ governance: ["specs/constraints.md", "specs/decisions/0007-x.md"] }));
		expect(r).toContain("specs/constraints.md");
		expect(r).toContain("specs/decisions/0007-x.md");
	});

	test("reasons follow the spec's bullet order", () => {
		const o = laneRule(
			facts({
				files: ["a", "b", "c", "d"],
				lines: 500,
				spec_changes: [{ capability: "forge-read", added_requirements: ["X"], removed_requirements: [], scenarios: [] }],
				created_capabilities: ["retry-policy"],
				governance: ["specs/constraints.md"],
			}),
			CONFIG,
		);
		expect(o.lane).toBe("forced");
		expect(o.reasons).toHaveLength(5);
		expect(o.reasons[0]).toContain("max_files");
		expect(o.reasons[1]).toContain("max_lines");
		expect(o.reasons[2]).toContain("forge-read");
		expect(o.reasons[3]).toContain("retry-policy");
		expect(o.reasons[4]).toContain("specs/constraints.md");
	});

	test("Code without spec change", () => {
		const o = laneRule(
			facts({ files: ["src/forge/read.ts"], spec_changes: [], capability_code: [{ capability: "forge-read", files: ["src/forge/read.ts"], spec_changed: false }] }),
			CONFIG,
		);
		expect(o).toEqual({ lane: "small", reasons: [], behavior_change: "declared-none", capabilities: ["forge-read"] });
	});

	test("Code with spec change", () => {
		const o = laneRule(facts(), CONFIG);
		expect(o).not.toHaveProperty("behavior_change");
		expect(o).not.toHaveProperty("capabilities");
	});

	test("declared-none also holds on a forced outcome", () => {
		const o = laneRule(
			facts({ files: ["a", "b", "c", "src/forge/read.ts"], spec_changes: [], capability_code: [{ capability: "forge-read", files: ["src/forge/read.ts"], spec_changed: false }] }),
			CONFIG,
		);
		expect(o.lane).toBe("forced");
		expect(o.behavior_change).toBe("declared-none");
		expect(o.capabilities).toEqual(["forge-read"]);
	});
});

describe("laneConfigOf", () => {
	const packWith = (decisions: Record<string, unknown>) => ({ decisions }) as unknown as Pack;

	test("a complete config is returned as is", () => {
		expect(laneConfigOf(packWith({ lane: CONFIG }))).toEqual(CONFIG);
	});

	test("a missing lane config is invalid", () => {
		expect(laneConfigOf(packWith({}))).toEqual({ invalid: "the flow pack has no complete `decisions.lane` config: `decisions.lane` is missing" });
	});

	test("a config without limits is invalid", () => {
		expect(laneConfigOf(packWith({ lane: { mode: "rule", max_files: 3 } }))).toEqual({ invalid: "the flow pack has no complete `decisions.lane` config: `decisions.lane.max_lines` is missing" });
	});
});

describe("laneRuleFn", () => {
	test("reason joins the reasons", () => {
		const r = laneRuleFn(facts({ files: ["a", "b", "c", "d"], lines: 101 }), CONFIG);
		expect("outcome" in r && r.reason).toBe(`${(r as { outcome: { reasons: string[] } }).outcome.reasons.join("; ")}`);
		expect("outcome" in r && r.reason).toContain("; ");
	});

	test("reason when small", () => {
		expect(laneRuleFn(facts(), CONFIG)).toEqual({ outcome: { lane: "small", reasons: [] }, reason: "within the small-fix limits" });
	});
});

function schemaErrors(yaml: string) {
	const lc = new LineCounter();
	const doc = parseDocument(yaml, { lineCounter: lc });
	const errors: { line: number; col: number; message: string }[] = [];
	const node = doc.contents;
	if (!isMap(node)) throw new Error("map expected");
	laneSchema.validate(node, (n, message) => {
		const pos = lc.linePos(n.range?.[0] ?? 0);
		errors.push({ line: pos.line, col: pos.col, message });
	});
	return errors;
}

describe("laneSchema", () => {
	test("valid config has no errors", () => {
		expect(schemaErrors("mode: rule\nmax_files: 3\nmax_lines: 100\n")).toEqual([]);
		expect(schemaErrors("mode: rule\nmax_files: 5\n")).toEqual([]);
	});

	test("Invalid limit", () => {
		const errors = schemaErrors("mode: rule\nmax_files: 0\n");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ line: 2, col: 12 });
		expect(errors[0]?.message).toContain("max_files");
	});

	test("non-number limit", () => {
		const errors = schemaErrors('mode: rule\nmax_lines: "x"\n');
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ line: 2, col: 12 });
		expect(errors[0]?.message).toContain("max_lines");
	});

	test("non-integer limit", () => {
		expect(schemaErrors("mode: rule\nmax_lines: 1.5\n")[0]?.message).toContain("max_lines");
	});

	test("complete config: every missing limit is named", () => {
		expect(laneSchema.complete?.({ mode: "rule" })).toEqual(["`decisions.lane.max_files` is missing", "`decisions.lane.max_lines` is missing"]);
		expect(laneSchema.complete?.(CONFIG)).toEqual([]);
	});

	test("unknown key", () => {
		const errors = schemaErrors("mode: rule\nmax_bytes: 3\n");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ line: 2, col: 1 });
		expect(errors[0]?.message).toContain("max_bytes");
	});
});
