// The `behavior-change` facts, rule, precedence and check (durable-doc-checks "Behavior conclusion rule",
// "Behavior conclusion precedence", "Behavior conclusion check").

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { type DecisionRecord, decisionComment } from "../../src/decide/records.ts";
import { ledgerRecord } from "../helpers/ledger.ts";
import "../../src/decide/builtin.ts";
import { registerBuiltinRules, registerRule, resetRulesForTests } from "../../src/decide/registry.ts";
import { type DecisionAsk, decide } from "../../src/decide/seam.ts";
import { type BehaviorItem, behaviorDigest, behaviorFacts, behaviorResults, effectiveConclusion } from "../../src/docs/behavior-change.ts";
import { behaviorChangeCheck } from "../../src/docs/behavior-check.ts";
import type { CheckContext } from "../../src/engine/registry.ts";
import { type MarkedComment, parseMarked, writeMarked } from "../../src/forge/markers.ts";

const SPECS = [{ capability: "rate-limit", paths: ["src/limit/**"] }];
const CAP = "src/limit/cap.ts";
const WINDOW = "src/limit/window.ts";
const ITEM: BehaviorItem = { capability: "rate-limit", files: [CAP] };
const GROWN: BehaviorItem = { capability: "rate-limit", files: [CAP, WINDOW] };

function marked(body: string): MarkedComment {
	const m = parseMarked(body);
	if (m === undefined) throw new Error(`not a marked comment: ${body}`);
	return { ...m, source: "forge", ref: `c-${Math.random()}`, author: "bot" } as MarkedComment;
}

function record(outcome: string, item: BehaviorItem = ITEM, extra: Partial<DecisionRecord> = {}): MarkedComment {
	const r: DecisionRecord = { point: "behavior-change", subject: item.capability, digest: behaviorDigest(item.files), source: "human", outcome, facts: item, files: item.files, reason: "chosen by alice", ...extra };
	// A human record from the forge (a pre-ledger comment); a ledger one counts only beside its forge answer (I3).
	return { ...ledgerRecord(decisionComment(r), { ref: `c-${Math.random()}` }), source: "forge" };
}

let answers = 0;

/** A legacy human answer as main stores it: a ledger decision naming its request, beside the own forge `answer` that backs it. */
function backedHuman(outcome: string, item: BehaviorItem = ITEM): MarkedComment[] {
	const request = `decide-behavior-change-rate-limit.${++answers}`;
	const r: DecisionRecord = { point: "behavior-change", subject: item.capability, digest: behaviorDigest(item.files), source: "human", outcome, facts: item, files: item.files, reason: "chosen by alice", request };
	const answer = marked(writeMarked("answer", request, { request: { subject: `decide:behavior-change.${item.capability}` }, answer: { outcome: "answered", choice: outcome }, verdict: "valid" }));
	return [ledgerRecord(decisionComment(r)), answer];
}

function openRequest(capability: string): MarkedComment {
	const subject = `decide:behavior-change.${capability}`;
	return marked(writeMarked("request", "decide-behavior-change-rate-limit.abc", { kind: "stuck", subject, mode: "blocking", head_sha: "h", snapshot: {}, summary: "s" }));
}

const roots: string[] = [];
afterEach(async () => {
	for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

const SPEC = "---\npaths: [\"src/limit/**\"]\n---\n# rate-limit\n\n## Purpose\nCap.\n\n## Requirements\n\n### Requirement: Cap\nThe system SHALL cap.\n\n#### Scenario: capped\n- **WHEN** a\n- **THEN** b\n";

async function specRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ls-behavior-"));
	roots.push(root);
	await mkdir(join(root, "specs", "rate-limit"), { recursive: true });
	await writeFile(join(root, "specs", "rate-limit", "spec.md"), SPEC);
	return root;
}

function checkCtx(root: string, files: string[], comments: MarkedComment[]): CheckContext {
	const git = { diff: async () => "", diffNameStatus: async () => files.map((path) => ({ status: "M", path })), head: async () => "h", showFile: async () => undefined, listTree: async () => [], hasCommit: async () => true };
	return { root, change: parseChange("Base: abc123\n"), marked: comments, phase: "define", git };
}

describe("behavior facts", () => {
	test("Code changed, spec unchanged", () => {
		expect(behaviorFacts([CAP], SPECS)).toEqual([{ capability: "rate-limit", files: [CAP] }]);
	});

	test("Spec changed too", () => {
		expect(behaviorFacts([CAP, "specs/rate-limit/spec.md"], SPECS)).toEqual([]);
	});

	test("files sorted; spec files and unmatched files left out", () => {
		expect(behaviorFacts([WINDOW, "README.md", "specs/glossary.md", CAP], SPECS)).toEqual([{ capability: "rate-limit", files: [CAP, WINDOW] }]);
	});

	test("digest is sha256 of the files joined by newlines", () => {
		expect(behaviorDigest([CAP, WINDOW])).toMatch(/^[0-9a-f]{64}$/);
		expect(behaviorDigest([CAP, WINDOW])).not.toBe(behaviorDigest([CAP]));
	});
});

describe("behavior-change rule", () => {
	test("Rule never asks", async () => {
		const ask = vi.fn(async (_intent: DecisionAsk) => ({ status: "pending" as const, requestId: "r1" }));
		const decided = await decide("behavior-change", ITEM, { config: { mode: "rule" }, subject: ITEM.capability, digest: behaviorDigest(ITEM.files), ask });
		expect(ask).not.toHaveBeenCalled();
		expect(decided).toMatchObject({ status: "decided", outcome: null, source: "rule" });
	});

	test("Rule ask carries descriptions", async () => {
		resetRulesForTests();
		registerRule("pick", { validate() {} }, () => ({ ask: { summary: "Pick one for U1", options: [{ id: "x", label: "X", description: "Do x." }, { id: "y", label: "Y", description: "Do y." }], recommended: "x", rationale: "x is simplest." } }));
		try {
			const ask = vi.fn(async (_intent: DecisionAsk) => ({ status: "pending" as const, requestId: "r1" }));
			await decide("pick", ITEM, { config: {}, subject: "U1", ask });
			const intent = ask.mock.calls[0]?.[0];
			expect(intent?.options.map((o) => o.description)).toEqual(["Do x.", "Do y."]);
			expect(intent?.recommended).toBe("x");
			expect(intent?.rationale).toBe("x is simplest.");
		} finally {
			resetRulesForTests();
			registerBuiltinRules();
		}
	});
});

describe("behavior conclusion precedence", () => {
	test("Agent re-concludes after request changes", () => {
		const marks = [record("unchanged", ITEM, { source: "agent", reason: "refactor only" }), record("changed", ITEM, { source: "agent", reason: "cap now rejects at 99" })];
		expect(effectiveConclusion(marks, ITEM)).toMatchObject({ outcome: "changed", source: "agent", reason: "cap now rejects at 99" });
	});

	test("Agent cannot undo a human change", () => {
		for (const later of [ITEM, GROWN]) {
			const marks = [...backedHuman("changed"), record("unchanged", later, { source: "agent", reason: "refactor only" })];
			expect(effectiveConclusion(marks, later)).toMatchObject({ outcome: "changed", source: "human" });
			const [r] = behaviorResults([later], marks, "define");
			expect(r?.message).toContain("specs/rate-limit/spec.md");
		}
	});

	test("an unbacked ledger human change does not count", () => {
		const [decision] = backedHuman("changed");
		expect(effectiveConclusion([decision as MarkedComment], ITEM)).toBeUndefined();
	});

	test("a later human answer replaces an earlier human change", () => {
		expect(effectiveConclusion([...backedHuman("changed"), ...backedHuman("unchanged")], ITEM)).toMatchObject({ outcome: "unchanged", source: "human" });
	});

	test("Adding a file does not undo a human change", () => {
		const marks = [record("changed"), record("unchanged", GROWN, { source: "agent" })];
		expect(effectiveConclusion(marks, GROWN)).toMatchObject({ outcome: "changed", source: "human" });
		const [r] = behaviorResults([GROWN], marks, "define");
		expect(r?.message).toContain("specs/rate-limit/spec.md");
	});

	test("Later agent record wins over an earlier agent record", () => {
		const marks = [record("unchanged", ITEM, { source: "agent" }), record("changed", ITEM, { source: "agent" })];
		expect(effectiveConclusion(marks, ITEM)).toMatchObject({ outcome: "changed", source: "agent" });
	});

	test("Old human answer still counts", () => {
		const marks = backedHuman("unchanged");
		expect(effectiveConclusion(marks, ITEM)).toMatchObject({ outcome: "unchanged", source: "human" });
	});

	test("New file needs a new conclusion", () => {
		expect(effectiveConclusion([record("unchanged", ITEM, { source: "agent" })], GROWN)).toBeUndefined();
	});

	test("a reviewer-source record is not a conclusion", () => {
		expect(effectiveConclusion([record("changed", ITEM, { source: "reviewer" as never })], ITEM)).toBeUndefined();
	});
});

describe("behavior-change check", () => {
	test("Unconcluded item names the parameter", () => {
		const [r] = behaviorResults([ITEM], [], "define");
		expect(r).toMatchObject({ code: "behavior-change", severity: "error" });
		expect(r?.message).toContain("behavior");
		expect(r?.message).toContain("spec_gate define");
	});

	test("Legacy open request is named", () => {
		const [r] = behaviorResults([ITEM], [openRequest("rate-limit")], "review");
		expect(r?.message).toContain("decide:behavior-change.rate-limit");
		expect(r?.message).toContain("spec_gate review");
	});

	test("Behavior changed without a spec edit", () => {
		const [r] = behaviorResults([ITEM], [record("changed")], "define");
		expect(r?.severity).toBe("error");
		expect(r?.message).toContain("specs/rate-limit/spec.md");
		expect(r?.message).toContain("human");
	});

	test("unchanged record reports nothing", () => {
		expect(behaviorResults([ITEM], [record("unchanged")], "define")).toEqual([]);
	});

	test("Spec updated after a changed conclusion", async () => {
		const root = await specRoot();
		expect(await behaviorChangeCheck(checkCtx(root, [CAP, "specs/rate-limit/spec.md"], [record("changed")]))).toEqual([]);
	});

	test("check reads the diff from Base and the living specs", async () => {
		const root = await specRoot();
		const out = await behaviorChangeCheck(checkCtx(root, [CAP], []));
		expect(out).toHaveLength(1);
		expect(out[0]?.message).toContain("spec_gate define");
	});
});
