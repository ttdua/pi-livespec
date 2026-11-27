import { isMap, LineCounter, parseDocument } from "yaml";
import { describe, expect, test } from "vitest";
import type { GateEscalationFacts } from "../../src/engine/gate-escalation-facts.ts";
import { type GateEscalationConfig, gateEscalationRule, gateEscalationSchema } from "../../src/decide/rules/gate-escalation.ts";

const CONFIG: GateEscalationConfig = { mode: "rule", phases: ["plan"], tags: ["security", "migration"] };

function facts(over: Partial<GateEscalationFacts> = {}): GateEscalationFacts {
	return { phase: "plan", head_sha: "abc", failing_waivable: [], advisory_review: "clean", units: [{ id: "U1", tags: ["ui"] }, { id: "U2", tags: [] }], ...over };
}

function run(f: GateEscalationFacts, config: GateEscalationConfig = CONFIG): { outcome: unknown; reason: string } {
	const r = gateEscalationRule(f, config);
	if (!("outcome" in r)) throw new Error("gate-escalation never asks");
	return r;
}

describe("gate-escalation rule", () => {
	test("no trigger", () => {
		expect(run(facts())).toEqual({ outcome: "self", reason: "no trigger" });
	});

	test("every trigger named", () => {
		const r = run(facts({ failing_waivable: ["size-limits"], advisory_review: "critical", units: [{ id: "U3", tags: ["migration"] }] }));
		expect(r.outcome).toBe("human");
		expect(r.reason).toContain("size-limits");
		expect(r.reason).toContain("CRITICAL advisory finding");
		expect(r.reason).toContain("U3");
		expect(r.reason).toContain("migration");
		expect(r.reason).toBe("size-limits fails; CRITICAL advisory finding in the plan review; U3 tagged migration");
	});

	test("missing advisory review", () => {
		const r = run(facts({ advisory_review: "missing" }));
		expect(r.outcome).toBe("human");
		expect(r.reason).toContain("missing");
		expect(r.reason).toBe("advisory plan review missing at HEAD");
	});

	test("no advisory reviewer is no trigger", () => {
		expect(run(facts({ advisory_review: "none" })).outcome).toBe("self");
	});

	test("project adds a tag", () => {
		const merged = gateEscalationSchema.merge?.(CONFIG, { mode: "rule", tags: ["security", "migration", "api"] }) as GateEscalationConfig;
		expect(merged).toEqual({ mode: "rule", phases: ["plan"], tags: ["security", "migration", "api"] });
		const r = run(facts({ units: [{ id: "U1", tags: ["api"] }] }), merged);
		expect(r).toEqual({ outcome: "human", reason: "U1 tagged api" });
	});
});

function schemaErrors(text: string) {
	const lc = new LineCounter();
	const doc = parseDocument(text, { lineCounter: lc });
	const node = doc.contents;
	if (!isMap(node)) throw new Error("map expected");
	const errors: { line: number; col: number; message: string }[] = [];
	gateEscalationSchema.validate(node, (n, message) => {
		const pos = lc.linePos(n.range?.[0] ?? 0);
		errors.push({ line: pos.line, col: pos.col, message });
	});
	return errors;
}

describe("gateEscalationSchema", () => {
	test("valid config", () => {
		expect(schemaErrors("mode: rule\nphases: [plan]\ntags: [security, migration]\n")).toEqual([]);
	});

	test("phases not a list", () => {
		const errors = schemaErrors("mode: rule\nphases: plan\n");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ line: 2, col: 9 });
		expect(errors[0]?.message).toContain("decisions.gate-escalation.phases");
	});

	test("empty tag entry", () => {
		const errors = schemaErrors('mode: rule\ntags: [security, ""]\n');
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("decisions.gate-escalation.tags");
	});

	test("unknown key", () => {
		const errors = schemaErrors("mode: rule\nlevels: [plan]\n");
		expect(errors[0]).toMatchObject({ line: 2, col: 1 });
	});

	test("complete names a missing list", () => {
		expect(gateEscalationSchema.complete?.({ mode: "rule", phases: ["plan"] })).toEqual(["`decisions.gate-escalation.tags` is missing"]);
		expect(gateEscalationSchema.complete?.(CONFIG)).toEqual([]);
	});
});
