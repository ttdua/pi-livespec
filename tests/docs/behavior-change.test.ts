// The `behavior-change` facts, rule and check (durable-doc-checks "Behavior change facts", "Behavior change rule",
// "Behavior change check").

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { type DecisionRecord, decisionComment } from "../../src/decide/records.ts";
import { ledgerRecord } from "../helpers/ledger.ts";
import "../../src/decide/builtin.ts";
import { type DecisionAsk, decide } from "../../src/decide/seam.ts";
import { behaviorDigest, behaviorFacts, behaviorResults, type BehaviorItem } from "../../src/docs/behavior-change.ts";
import { behaviorChangeCheck } from "../../src/docs/behavior-check.ts";
import type { CheckContext } from "../../src/engine/registry.ts";
import { type MarkedComment, parseMarked, writeMarked } from "../../src/forge/markers.ts";

const SPECS = [{ capability: "rate-limit", paths: ["src/limit/**"] }];
const CAP = "src/limit/cap.ts";
const WINDOW = "src/limit/window.ts";
const ITEM: BehaviorItem = { capability: "rate-limit", files: [CAP] };

function marked(body: string): MarkedComment {
	const m = parseMarked(body);
	if (m === undefined) throw new Error(`not a marked comment: ${body}`);
	return { ...m, source: "forge", ref: `c-${Math.random()}`, author: "bot" } as MarkedComment;
}

function record(outcome: string, item: BehaviorItem = ITEM, extra: Partial<DecisionRecord> = {}): MarkedComment {
	const r: DecisionRecord = { point: "behavior-change", subject: item.capability, digest: behaviorDigest(item.files), source: "human", outcome, facts: item, files: item.files, reason: "chosen by alice", ...extra };
	return ledgerRecord(decisionComment(r), { ref: `c-${Math.random()}` });
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
	test("Always asks", async () => {
		const ask = vi.fn(async (_intent: DecisionAsk) => ({ status: "pending" as const, requestId: "r1" }));
		await decide("behavior-change", ITEM, { config: { mode: "rule" }, subject: ITEM.capability, digest: behaviorDigest(ITEM.files), ask });
		const intent = ask.mock.calls[0]?.[0];
		expect(intent).toMatchObject({ point: "behavior-change", subject: "rate-limit", digest: behaviorDigest([CAP]), facts: ITEM });
		expect(intent?.options.map((o) => o.id)).toEqual(["unchanged", "changed"]);
	});

	test("Rule ask carries descriptions", async () => {
		const ask = vi.fn(async (_intent: DecisionAsk) => ({ status: "pending" as const, requestId: "r1" }));
		await decide("behavior-change", ITEM, { config: { mode: "rule" }, subject: ITEM.capability, ask });
		const intent = ask.mock.calls[0]?.[0];
		expect(intent?.options.map((o) => o.description)).toEqual(["A refactor: the spec stays as it is.", "Behavior changed: the gate refuses until specs/<capability>/spec.md is updated."]);
		expect(intent?.recommended).toBeUndefined();
	});
});

describe("behavior-change check", () => {
	test("Unanswered item names the gate", () => {
		const [r] = behaviorResults([ITEM], [], "define");
		expect(r).toMatchObject({ code: "behavior-change", severity: "error" });
		expect(r?.message).toContain("spec_gate define");
	});

	test("open request is named as waiting", () => {
		const [r] = behaviorResults([ITEM], [openRequest("rate-limit")], "review");
		expect(r?.message).toContain("decide:behavior-change.rate-limit");
		expect(r?.message).not.toContain("spec_gate");
	});

	test("Behavior changed without a spec edit", () => {
		const [r] = behaviorResults([ITEM], [record("changed")], "define");
		expect(r?.severity).toBe("error");
		expect(r?.message).toContain("specs/rate-limit/spec.md");
	});

	test("unchanged record reports nothing", () => {
		expect(behaviorResults([ITEM], [record("unchanged")], "define")).toEqual([]);
	});

	test("New file asks again", () => {
		const now: BehaviorItem = { capability: "rate-limit", files: [CAP, WINDOW] };
		const [r] = behaviorResults([now], [record("unchanged")], "define");
		expect(r?.message).toContain("spec_gate define");
	});

	test("Spec updated after a changed answer", async () => {
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
