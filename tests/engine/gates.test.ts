import { beforeEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { decisionComment } from "../../src/decide/records.ts";
import { registerBuiltinRules } from "../../src/decide/registry.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { registerBuiltinChecks } from "../../src/engine/checks.ts";
import { gatePayload, type ReviewFacts } from "../../src/engine/gate-payload.ts";
import { untrusted } from "../../src/hooks/phase-card.ts";
import { blockingStateRefusal, gateRefusal, registerGate, registerGatePayload, resetGatesForTests } from "../../src/engine/gates.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { registerCheck, resetRegistryForTests } from "../../src/engine/registry.ts";
import type { ChangeState } from "../../src/engine/state-types.ts";
import { type MarkedComment, parseMarked } from "../../src/forge/markers.ts";
import type { PendingRequest } from "../../src/interaction/requests.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";
import { finding, mark, rebutted, reviewed } from "../subagents/helpers.ts";
import { writeMarked } from "../../src/forge/markers.ts";

/** The fixture body with Q1 answered, so no blocking question is open. */
const NO_QUESTION = FIXTURE_BODY.replace("- [ ] Q1 (blocking): Which header carries the client IP behind the proxy?", "- [x] Q1 (blocking): Which header carries the client IP behind the proxy? — Answer: X-Forwarded-For");

const FACTS: ReviewFacts = {
	specsStat: " specs/rate-limit/spec.md | 12 ++++++++++--\n 1 file changed, 10 insertions(+), 2 deletions(-)",
	specsFiles: ["specs/rate-limit/spec.md"],
	issueUrl: "https://forge.example/o/r/issues/7",
};

let pack: Pack;

beforeEach(async () => {
	resetRegistryForTests();
	resetGatesForTests();
	registerBuiltinRules();
	registerBuiltinChecks();
	const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
	if (!loaded.ok) throw new Error("default pack must load");
	pack = loaded.pack;
});

function ready(phase: string, overrides: Partial<ChangeState> = {}, body = NO_QUESTION): ChangeState {
	return stateFor(phase, overrides, body);
}

function pendingGate(target: string, id = `gate-${target}.abc`): PendingRequest {
	const data = { id, kind: "gate" as const, subject: `gate:${target}` as const, mode: "blocking" as const, head_sha: "f", snapshot: { target, failingWaivable: [] }, summary: "s" };
	return { id, subject: `gate:${target}`, kind: "gate", mode: "blocking", createdAt: "t", data };
}

function decision(point: string, unit: string, outcome: unknown, reason: string, extra: Record<string, unknown> = {}): MarkedComment {
	const u = parseChange(NO_QUESTION).units.find((x) => x.id === unit);
	if (!u) throw new Error(unit);
	const parsed = parseMarked(decisionComment({ point, subject: unit, digest: unitDigest(u), source: "rule", outcome, reason, ...extra }));
	if (!parsed) throw new Error("bad decision");
	return { commentId: `c-${point}-${unit}`, author: "bot", ...parsed };
}

describe("gateRefusal", () => {
	test("a ready phase gate is not refused", () => {
		expect(gateRefusal(ready("define"), pack, "define")).toBeUndefined();
	});

	test("Blocking question keeps the gate closed", () => {
		const refusal = gateRefusal(stateFor("define"), pack, "define");
		expect(refusal).toBe("Blocking question Q1 is open: answer it before requesting the gate.");
	});

	test("Failing check that is not waivable", () => {
		const checks = [{ check: "spec-format", code: "spec-missing", severity: "error" as const, file: "specs/rate-limit/spec.md", message: "specs/rate-limit/spec.md does not exist" }];
		expect(gateRefusal(ready("define", { checks }), pack, "define")).toBe(`Check spec-format fails: ${untrusted("specs/rate-limit/spec.md does not exist")}.`);
		registerCheck("size-limits", async () => [], { waivable: true });
		const waivable = [{ check: "size-limits", code: "x", severity: "error" as const, message: "too big" }];
		expect(gateRefusal(ready("plan", { checks: waivable }), pack, "plan")).toBeUndefined();
		const warning = [{ check: "spec-format", code: "w", severity: "warning" as const, message: "minor" }];
		expect(gateRefusal(ready("define", { checks: warning }), pack, "define")).toBeUndefined();
	});

	test("Plan gate with a stale unit", () => {
		const lock = { locked: { U1: "a", U3: "b" }, frozen: [], staleUnits: ["U3"], gates: {} };
		expect(gateRefusal(ready("plan", { lock }), pack, "plan")).toBe("Amend the units changed since the plan was locked with unit_amend first: U3 (stale).");
		const frozen = { ...lock, frozen: ["U1"], staleUnits: ["U3"] };
		expect(gateRefusal(ready("plan", { lock: frozen }), pack, "plan")).toBe("Amend the units changed since the plan was locked with unit_amend first: U1 (frozen), U3 (stale).");
		expect(gateRefusal(ready("define", { lock }), pack, "define")).toBeUndefined();
	});

	test("Cap reached", () => {
		const iterations = { count: 5, cap: 5, blocking: true, stuckOpen: undefined };
		expect(gateRefusal(ready("define", { iterations }), pack, "define")).toBe("change_iterations reached 5 of 5: send a stuck report with spec_stuck first.");
	});

	test("open stuck report refuses", () => {
		const iterations = { count: 0, cap: 5, blocking: false, stuckOpen: "S1" };
		expect(gateRefusal(ready("define", { iterations }), pack, "define")).toBe("Stuck report S1 is unanswered: wait for the human's choice.");
	});

	test("named gate is accepted outside its phase", () => {
		expect(gateRefusal(ready("build"), pack, "new-dependency")).toBe("new-dependency is neither the current phase (build) nor a registered gate.");
		registerGate("new-dependency", { checks: ["dep-ok"] });
		expect(gateRefusal(ready("build"), pack, "new-dependency")).toBeUndefined();
		const failing = [{ check: "dep-ok", code: "x", severity: "error" as const, message: "missing licence" }];
		expect(gateRefusal(ready("build", { checks: failing }), pack, "new-dependency")).toBe(`Check dep-ok fails: ${untrusted("missing licence")}.`);
		const other = [{ check: "units-format", code: "x", severity: "error" as const, message: "unrelated" }];
		expect(gateRefusal(ready("build", { checks: other }), pack, "new-dependency")).toBeUndefined();
		expect(gateRefusal(ready("define"), pack, "plan")).toBe("plan is neither the current phase (define) nor a registered gate.");
	});

	test("dirty tree refuses", () => {
		const git = { branch: "b", head: "f", dirty: true, specsChanged: true };
		expect(gateRefusal(ready("define", { git }), pack, "define")).toBe("The working tree is dirty: commit before requesting a gate.");
	});

	test("gate none refuses", () => {
		expect(gateRefusal(ready("build"), pack, "build")).toBe("The build phase has no gate.");
	});

	test("pending request for the subject refuses", () => {
		const requests = { pending: [pendingGate("define")], applying: [] };
		expect(gateRefusal(ready("define", { requests }), pack, "define")).toBe(
			"A request for gate:define is pending (gate-define.abc): wait for its answer or end it with /livespec dismiss.",
		);
		const other = { pending: [pendingGate("plan")], applying: [] };
		expect(gateRefusal(ready("define", { requests: other }), pack, "define")).toBeUndefined();
	});

	test("the ignored request does not refuse", () => {
		const requests = { pending: [pendingGate("define")], applying: [] };
		expect(gateRefusal(ready("define", { requests }), pack, "define", "gate-define.abc")).toBeUndefined();
		expect(gateRefusal(ready("define", { requests }), pack, "define", "gate-define.other")).toBeDefined();
	});
});

describe("gatePayload", () => {
	test("Plan payload", () => {
		const marked = [
			decision("tags", "U1", [], "no path or keyword matched"),
			decision("difficulty", "U1", "low", "one file without tags"),
			decision("tags", "U3", ["security", "api"], "src/middleware/ratelimit.ts matches **/middleware/**", { agent_additions: ["api"] }),
			decision("difficulty", "U3", "medium", "default"),
		];
		const otherContract = parseMarked(
			decisionComment({ point: "tags", subject: "U3", digest: "0".repeat(64), source: "human", outcome: ["perf"], reason: "older contract reason" }),
		);
		if (!otherContract) throw new Error("bad decision");
		marked.push({ commentId: "c-old", author: "bot", ...otherContract });
		const payload = gatePayload(ready("plan", { marked }), pack, "plan", FACTS);
		expect(payload.summary).toBe(
			[
				"Gate plan for #7 per-ip-cap.",
				"",
				"Units:",
				"- U1 — Request context · Difficulty: low · Tags: [] · Covers: request-context/Requirement: Client IP",
				"- U3 — Rate limit per IP · Difficulty: medium · Tags: [security, api] · Covers: rate-limit/Requirement: Per-IP cap",
				"",
				"Decisions:",
				"- tags.U1: no path or keyword matched",
				"- difficulty.U1: one file without tags",
				"- tags.U3: src/middleware/ratelimit.ts matches **/middleware/** (agent additions: api)",
				"- difficulty.U3: default",
			].join("\n"),
		);
		expect(payload.links).toEqual([FACTS.issueUrl]);
	});

	test("Define payload", () => {
		const payload = gatePayload(ready("define"), pack, "define", FACTS);
		expect(payload.summary).toBe(
			[
				"Gate define for #7 per-ip-cap.",
				"",
				"Capabilities: new [], modified [rate-limit]",
				"Product impact: none — internal limit only",
				"",
				"Proposal:",
				"Limit each client IP.",
				`Full text: ${FACTS.issueUrl}`,
				"",
				"Spec diff (git diff --stat 0123456789abcdef0123456789abcdef01234567..HEAD -- specs/):",
				FACTS.specsStat,
				"",
				"Changed spec files:",
				"- specs/rate-limit/spec.md",
			].join("\n"),
		);
		expect(payload.files).toEqual(["specs/rate-limit/spec.md"]);
		expect(payload.links).toEqual([FACTS.issueUrl]);
	});

	test("define payload lists full spec paths when the stat truncates them", () => {
		const long = "specs/a-very-long-capability-name-that-git-truncates/spec.md";
		const facts = { specsStat: " .../spec.md | 3 +++\n 1 file changed, 3 insertions(+)", specsFiles: [long] };
		const summary = gatePayload(ready("define"), pack, "define", facts).summary;
		expect(summary).toContain(`Changed spec files:\n- ${long}`);
	});

	test("long proposal is cut to its first lines", () => {
		const long = NO_QUESTION.replace("Limit each client IP.", ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\n"));
		const summary = gatePayload(ready("define", {}, long), pack, "define", { specsStat: "", specsFiles: [] }).summary;
		expect(summary).toContain("Proposal:\nl1\nl2\nl3\nl4\nl5\n…\n\nSpec diff");
	});

	test("ship payload lists the durable docs table", () => {
		const summary = gatePayload(ready("ship"), pack, "ship", FACTS).summary;
		expect(summary).toContain("Durable docs:\n| File | Status |\n|---|---|\n| specs/<capability>/spec.md | updated |");
	});

	test("registered payload is appended", () => {
		registerGatePayload("ship", (s) => `Review: ${s.issue.title} passed`);
		registerGatePayload("ship", () => undefined);
		registerGatePayload("define", () => "never for ship");
		const summary = gatePayload(ready("ship"), pack, "ship", FACTS).summary;
		expect(summary.endsWith("\n\nReview: per-ip-cap passed")).toBe(true);
		expect(summary).not.toContain("never for ship");
	});

	test("named gate payload is the header", () => {
		registerGate("new-dependency", { checks: [] });
		expect(gatePayload(ready("build"), pack, "new-dependency", FACTS)).toEqual({ summary: "Gate new-dependency for #7 per-ip-cap.", links: [FACTS.issueUrl], files: [], findings: [] });
	});
});

describe("blockingStateRefusal", () => {
	const Q1 = "Blocking question Q1 is open: answer it before requesting the gate.";
	const S1 = "Stuck report S1 is unanswered: wait for the human's choice.";

	test("no blocking state gives undefined", () => {
		expect(blockingStateRefusal(ready("define"))).toBeUndefined();
	});

	test("an open blocking question refuses", () => {
		expect(blockingStateRefusal(stateFor("define"))).toBe(Q1);
	});

	test("an open stuck report refuses", () => {
		const iterations = { count: 0, cap: undefined, blocking: false, stuckOpen: "S1" };
		expect(blockingStateRefusal(ready("define", { iterations }))).toBe(S1);
	});

	test("a reached cap refuses", () => {
		const iterations = { count: 5, cap: 5, blocking: true, stuckOpen: undefined };
		expect(blockingStateRefusal(ready("define", { iterations }))).toBe("change_iterations reached 5 of 5: send a stuck report with spec_stuck first.");
	});

	test("the first rule in order wins", () => {
		const iterations = { count: 0, cap: undefined, blocking: false, stuckOpen: "S1" };
		expect(blockingStateRefusal(stateFor("define", { iterations }))).toBe(Q1);
	});
});

describe("subagent findings in the gate payload", () => {
	const reviewer = (subject: string, over: Record<string, unknown> = {}) =>
		reviewed({ subject: subject as never, unit: undefined, advisory: true, findings: [finding({ severity: "CRITICAL", location: "specs/x/spec.md:3", evidence: "no scenario for 429" })], ...over });

	test("advisory spec review in gate payload", () => {
		const s = ready("define", { marked: [reviewer("spec")] });
		const payload = gatePayload(s, pack, "define", FACTS);
		expect(payload.summary).toContain("Subagent findings");
		expect(payload.summary).toContain("CRITICAL");
		expect(payload.summary).toContain(untrusted("no scenario for 429"));
	});

	test("an advisory finding does not block the gate request", () => {
		const s = ready("define", { marked: [reviewer("spec")] });
		expect(blockingStateRefusal(s)).toBeUndefined();
	});

	test("an advisory finding of another phase's reviewer is listed at the next gate", () => {
		const s = ready("define", { marked: [reviewer("plan")] });
		expect(gatePayload(s, pack, "define", FACTS).summary).toContain("no scenario for 429");
	});

	test("rebuttals in gate payload", () => {
		const summary = reviewed({ unit: "U3", findings: [finding({ evidence: "off by one" })] });
		const s = ready("define", { marked: [summary, rebutted(summary.commentId, 0, "limit is inclusive", "see ratelimit.ts:12")] });
		const text = gatePayload(s, pack, "define", FACTS).summary;
		expect(text).toContain("Subagent findings");
		expect(text).toContain("Rebuttals");
		expect(text).toContain(untrusted("limit is inclusive"));
		expect(text).toContain(untrusted("see ratelimit.ts:12"));
	});

	test("a malformed advisory summary is skipped", () => {
		const bad = { ...reviewer("spec"), data: { ...(reviewer("spec").data as object), findings: "oops" } } as MarkedComment;
		const s = ready("define", { marked: [bad] });
		expect(gatePayload(s, pack, "define", FACTS).summary).not.toContain("Subagent findings");
	});

	test("a superseded advisory summary is not listed", () => {
		const old = reviewer("spec", { findings: [finding({ severity: "CRITICAL", location: "specs/x/spec.md:3", evidence: "stale complaint" })] });
		const latest = reviewer("spec", { findings: [finding({ severity: "CRITICAL", location: "specs/x/spec.md:9", evidence: "fresh complaint" })] });
		const text = gatePayload(ready("define", { marked: [old, latest] }), pack, "define", FACTS).summary;
		expect(text).toContain("fresh complaint");
		expect(text).not.toContain("stale complaint");
	});

	const oos = () => reviewed({ findings: [finding({ scope: "out-of-scope", evidence: "unrelated module leaks" })] });
	const gateComment = (findings: unknown): MarkedComment =>
		mark(writeMarked("gate", "define.x", { phase: "define", outcome: "approved", notes: "", by: "a", at: "t", adapter: "in-session", head_sha: "f", waivers: [], findings }));

	test("gatePayload returns the keys of the findings it lists", () => {
		const review = oos();
		const advisory = reviewer("spec");
		const payload = gatePayload(ready("define", { marked: [review, advisory] }), pack, "define", FACTS);
		expect([...payload.findings].sort()).toEqual([`${advisory.commentId}:0`, `${review.commentId}:0`].sort());
	});

	test("out-of-scope findings are listed until a gate comment has recorded them", () => {
		const review = oos();
		expect(gatePayload(ready("define", { marked: [review] }), pack, "define", FACTS).summary).toContain("unrelated module leaks");
		const shown = gateComment([`${review.commentId}:0`]);
		const after = gatePayload(ready("define", { marked: [review, shown] }), pack, "define", FACTS);
		expect(after.summary).not.toContain("Out-of-scope findings");
		expect(after.findings).toEqual([]);
	});

	test("an unrelated amendment request does not mark findings shown", () => {
		const review = oos();
		const amend = mark(writeMarked("request", "amend-1.x", { kind: "gate", subject: "amend:1", mode: "blocking", head_sha: "f", snapshot: { action: "edit", unit: "U1", records: [] }, summary: "s" }));
		expect(gatePayload(ready("define", { marked: [review, amend] }), pack, "define", FACTS).summary).toContain("unrelated module leaks");
	});

	const buildAdvisory = () => reviewed({ subject: "unit", unit: "U1", advisory: true, findings: [finding({ evidence: "advisory build complaint" })] });

	test("an advisory build-unit finding is listed at a later ship gate", () => {
		const review = buildAdvisory();
		const payload = gatePayload(ready("ship", { marked: [review] }), pack, "ship", FACTS);
		expect(payload.summary).toContain("advisory build complaint");
		expect(payload.findings).toEqual([`${review.commentId}:0`]);
	});

	test("an advisory finding is not listed again once a gate comment recorded it", () => {
		const review = buildAdvisory();
		const shown = gateComment([`${review.commentId}:0`]);
		const after = gatePayload(ready("ship", { marked: [review, shown] }), pack, "ship", FACTS);
		expect(after.summary).not.toContain("advisory build complaint");
		expect(after.findings).toEqual([]);
	});

	test("malformed findings in a gate comment are ignored", () => {
		const review = oos();
		for (const bad of ["x", [1], { a: 1 }, null]) {
			expect(gatePayload(ready("define", { marked: [review, gateComment(bad)] }), pack, "define", FACTS).summary).toContain("unrelated module leaks");
		}
	});
});
