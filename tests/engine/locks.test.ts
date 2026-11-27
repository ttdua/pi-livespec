import { describe, expect, test } from "vitest";
import { type Change, parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { deriveLocks, gateDigest, validApproval } from "../../src/engine/locks.ts";
import type { MarkedComment } from "../../src/forge/markers.ts";
import { FIXTURE_BODY } from "../helpers/change-state.ts";

const U2_BLOCK = `### U2 — Header parsing
Covers: request-context/Requirement: Client IP
Difficulty: low
Tags: []
Files: src/headers.ts
Done means:
- [hdr] the forwarded header is parsed
Scenarios:
- [hdr] test/headers.test.ts › parses header
Depends: U1
Verify: \`npm test -- headers\`
- [ ] pending

`;

/** The fixture body with U2 between U1 and U3. */
const BODY = FIXTURE_BODY.replace("### U3 —", `${U2_BLOCK}### U3 —`);

let seq = 0;
function marked(kind: string, id: string, data: unknown): MarkedComment {
	seq += 1;
	return { commentId: `c${seq}`, kind, id, author: "bot", data };
}

function digests(change: Change): Record<string, string> {
	return Object.fromEntries(change.units.map((u) => [u.id, unitDigest(u)]));
}

function planGate(locked: Record<string, string>, over: Record<string, unknown> = {}): MarkedComment {
	return marked("gate", `plan.gate-plan.${seq}`, { request: `gate-plan.${seq}`, phase: "plan", outcome: "approved", notes: "", by: "alice", at: `2026-11-15T10:0${seq}:00Z`, adapter: "forge", head_sha: "f", waivers: [], locked, ...over });
}

function gate(phase: string, outcome: string, over: Record<string, unknown> = {}): MarkedComment {
	return marked("gate", `${phase}.r${seq}`, { request: `r${seq}`, phase, outcome, notes: "", by: "alice", at: `t${seq}`, adapter: "forge", head_sha: "f", waivers: [], ...over });
}

function stale(id: string, phases: string[], units: string[], afterPlan = false): MarkedComment {
	return marked("stale", id, { reason: id, phases, units, after_plan: afterPlan });
}

function amendment(action: "edit" | "add" | "drop", unit: string, over: Record<string, unknown> = {}): MarkedComment {
	return marked("amendment", `amend-${seq}`, { request: `amend-${seq}`, action, unit, outcome: "approved", by: "alice", at: "t", adapter: "forge", ...over });
}

const LATER = ["plan", "build", "review", "ship", "close"];

/** Where a `gate()` result comes from: its request, head and comment. */
const SOURCE = { request: expect.any(String), headSha: "f", commentId: expect.any(String) };

describe("deriveLocks", () => {
	test("no lock without an approved plan gate", () => {
		const change = parseChange(BODY);
		const lock = deriveLocks(change, [gate("plan", "changes_requested")]);
		expect(lock.locked).toBeUndefined();
		expect(lock.frozen).toEqual([]);
	});

	test("Web edit freezes a unit", () => {
		const locked = digests(parseChange(BODY));
		const edited = parseChange(BODY.replace("Verify: `npm test -- headers`", "Verify: `npm test -- headers --run`"));
		const lock = deriveLocks(edited, [planGate(locked)]);
		expect(lock.locked).toEqual(locked);
		expect(lock.frozen).toEqual(["U2"]);
	});

	test("Tick does not freeze", () => {
		const locked = digests(parseChange(BODY));
		const ticked = BODY.replace("Verify: `npm test -- headers`\n- [ ] pending", "Verify: `npm test -- headers`\n- [x] done")
			.replace("Difficulty: medium", "Difficulty: high")
			.replace("Tags: [security, api]", "Tags: [api]");
		const change = parseChange(ticked);
		expect(change.units.find((u) => u.id === "U2")?.done).toBe(true);
		expect(deriveLocks(change, [planGate(locked)]).frozen).toEqual([]);
	});

	test("Second plan gate re-locks", () => {
		const first = digests(parseChange(BODY));
		const amended = parseChange(BODY.replace("rejects 101st request", "rejects the 101st request"));
		const relocked = digests(amended);
		const lock = deriveLocks(amended, [
			planGate(first),
			stale("Q3", ["define", ...LATER], ["U3"], true),
			amendment("edit", "U3", { old: first.U3, new: relocked.U3 }),
			gate("define", "approved"),
			planGate(relocked),
		]);
		expect(lock.locked).toEqual(relocked);
		expect(lock.frozen).toEqual([]);
		expect(lock.staleUnits).toEqual([]);
		expect(lock.gates.define?.outcome).toBe("approved");
		expect(lock.gates.build).toBeUndefined();
	});

	test("amendment add and drop update the lock", () => {
		const twoUnits = parseChange(FIXTURE_BODY);
		const base = digests(twoUnits);
		const withU2 = parseChange(BODY.replace(/### U1 —[\s\S]*?(?=### U2)/, ""));
		const u2 = digests(withU2).U2 as string;
		const lock = deriveLocks(withU2, [
			planGate(base),
			amendment("add", "U2", { new: u2 }),
			amendment("drop", "U1", { old: base.U1 }),
			amendment("edit", "U3", { outcome: "changes_requested", new: "ignored" }),
			amendment("drop", "U3", { superseded: true }),
		]);
		expect(lock.locked).toEqual({ U3: base.U3, U2: u2 });
		expect(lock.frozen).toEqual([]);
	});

	test("stale unit cleared by a later approved amendment", () => {
		const change = parseChange(BODY);
		const locked = digests(change);
		const lock = deriveLocks(change, [
			planGate(locked),
			amendment("edit", "U2", { new: locked.U2 }),
			stale("Q3", ["define", ...LATER], ["U2", "U3"], true),
			amendment("edit", "U3", { new: locked.U3 }),
			amendment("edit", "U2", { new: locked.U2, outcome: "dismissed" }),
		]);
		expect(lock.staleUnits).toEqual(["U2"]);
	});

	test("Stale before the first lock", () => {
		const change = parseChange(BODY);
		const lock = deriveLocks(change, [stale("Q3", ["define", ...LATER], ["U2"]), planGate(digests(change))]);
		expect(lock.staleUnits).toEqual([]);
	});

	test("Identical amendment clears a stale unit", () => {
		const change = parseChange(BODY);
		const locked = digests(change);
		const lock = deriveLocks(change, [planGate(locked), stale("Q3", ["define", ...LATER], ["U3"], true), amendment("edit", "U3", { new: locked.U3 })]);
		expect(lock.staleUnits).toEqual([]);
	});

	test("superseded plan gate does not clear a stale unit", () => {
		const change = parseChange(BODY);
		const lock = deriveLocks(change, [stale("Q3", ["define", ...LATER], ["U2"]), planGate(digests(change), { superseded: true })]);
		expect(lock.staleUnits).toEqual(["U2"]);
	});

	test("stale after the plan approval stays stale", () => {
		const change = parseChange(BODY);
		const lock = deriveLocks(change, [planGate(digests(change)), stale("Q3", ["define", ...LATER], ["U2"], true)]);
		expect(lock.staleUnits).toEqual(["U2"]);
	});

	test("valid gate result ignores results older than a stale listing the phase", () => {
		const change = parseChange(BODY);
		const lock = deriveLocks(change, [gate("define", "approved"), stale("Q3", ["define", ...LATER], [])]);
		expect(lock.gates.define).toBeUndefined();
		const again = deriveLocks(change, [gate("define", "approved"), stale("Q3", ["define", ...LATER], []), gate("define", "changes_requested")]);
		expect(again.gates.define).toEqual({ outcome: "changes_requested", superseded: false, at: expect.any(String), waivers: [], notes: "", ...SOURCE });
		const approved = deriveLocks(change, [stale("Q3", ["define"], []), gate("define", "approved_with_notes", { at: "2026-11-15T11:00:00Z" })]);
		expect(approved.gates.define).toEqual({ outcome: "approved_with_notes", superseded: false, at: "2026-11-15T11:00:00Z", waivers: [], notes: "", ...SOURCE });
	});

	test("valid gate result carries its request, head and comment", () => {
		const reviewed = gate("review", "approved", { head_sha: "c3", request: "r7" });
		const lock = deriveLocks(parseChange(BODY), [reviewed]);
		expect(lock.gates.review).toMatchObject({ headSha: "c3", request: "r7", commentId: reviewed.commentId });
		const self = deriveLocks(parseChange(BODY), [gate("review", "approved", { head_sha: 3, request: undefined })]);
		expect(self.gates.review?.headSha).toBeUndefined();
		expect(self.gates.review?.request).toBeUndefined();
	});

	test("valid gate result carries the human's notes", () => {
		const lock = deriveLocks(parseChange(BODY), [gate("define", "changes_requested", { notes: "tighten the cap" })]);
		expect(lock.gates.define?.notes).toBe("tighten the cap");
		const bad = deriveLocks(parseChange(BODY), [gate("define", "dismissed", { notes: 42 })]);
		expect(bad.gates.define?.notes).toBe("");
	});

	test("valid gate result carries its waivers", () => {
		const lock = deriveLocks(parseChange(BODY), [gate("plan", "approved", { waivers: ["size-limits"] })]);
		expect(lock.gates.plan?.waivers).toEqual(["size-limits"]);
		const bad = deriveLocks(parseChange(BODY), [gate("plan", "approved", { waivers: "size-limits" })]);
		expect(bad.gates.plan?.waivers).toEqual([]);
	});

	test("superseded latest result gives no valid approval and does not fall back", () => {
		const change = parseChange(BODY);
		const lock = deriveLocks(change, [
			gate("define", "approved", { at: "2026-11-15T09:00:00Z" }),
			gate("define", "changes_requested", { at: "2026-11-15T10:00:00Z", superseded: true }),
		]);
		expect(validApproval(lock.gates.define)).toBe(false);
		expect(lock.gates.define).toEqual({ outcome: "changes_requested", superseded: true, at: "2026-11-15T10:00:00Z", waivers: [], notes: "", ...SOURCE });
		const approvedButSuperseded = deriveLocks(change, [gate("define", "approved"), gate("define", "approved", { superseded: true })]);
		expect(validApproval(approvedButSuperseded.gates.define)).toBe(false);
		expect(validApproval({ outcome: "approved_with_notes", superseded: false })).toBe(true);
		expect(validApproval({ outcome: "dismissed", superseded: false })).toBe(false);
		expect(validApproval(undefined)).toBe(false);
		const superseded = deriveLocks(parseChange(BODY), [planGate(digests(change)), planGate({ U1: "x" }, { superseded: true })]);
		expect(superseded.locked).toEqual(digests(change));
	});

	test("baseline is the gate the lock uses, with its requirement record parsed", () => {
		const change = parseChange(BODY);
		const requirements = { "rate-limit/Requirement: Per-IP cap": "a".repeat(64) };
		const first = planGate(digests(change));
		const second = planGate(digests(change), { requirements, requirement_scope: ["rate-limit"] });
		const lock = deriveLocks(change, [first, second]);
		expect(lock.baseline).toEqual({ at: 1, commentId: second.commentId, headSha: "f", requirements, scope: ["rate-limit"] });
	});

	test("baseline without a requirement record has neither field", () => {
		const change = parseChange(BODY);
		const gate = planGate(digests(change), { requirements: "bad", requirement_scope: [1] });
		expect(deriveLocks(change, [gate]).baseline).toEqual({ at: 0, commentId: gate.commentId, headSha: "f" });
		expect(deriveLocks(change, []).baseline).toBeUndefined();
	});

	test("baseline survives a later stale listing plan", () => {
		const change = parseChange(BODY);
		const gate = planGate(digests(change), { requirements: {}, requirement_scope: [] });
		const lock = deriveLocks(change, [gate, stale("spec.abc", ["define", ...LATER], ["U3"], true)]);
		expect(lock.gates.plan).toBeUndefined();
		expect(lock.baseline).toMatchObject({ at: 0, commentId: gate.commentId });
		expect(lock.locked).toBeDefined();
	});

	test("a spec cascade naming U3 makes it stale until a later approved amendment", () => {
		const change = parseChange(BODY);
		const cascade = stale("spec.0123456789ab", ["define", ...LATER], ["U3"], true);
		const before = deriveLocks(change, [planGate(digests(change)), cascade]);
		expect(before.staleUnits).toEqual(["U3"]);
		const after = deriveLocks(change, [planGate(digests(change)), cascade, amendment("edit", "U3", { new: unitDigest(change.units.find((u) => u.id === "U3")!) })]);
		expect(after.staleUnits).toEqual([]);
	});

	test("a missing-baseline record invalidates the define and plan results and keeps the lock", () => {
		const change = parseChange(BODY);
		const record = stale("baseline.0123456789ab", ["define", ...LATER], []);
		const lock = deriveLocks(change, [gate("define", "approved"), planGate(digests(change)), record]);
		expect(lock.gates.define).toBeUndefined();
		expect(lock.gates.plan).toBeUndefined();
		expect(lock.locked).toEqual(digests(change));
		expect(lock.staleUnits).toEqual([]);
	});

	test("foreign or malformed comments are ignored", () => {
		const change = parseChange(BODY);
		const lock = deriveLocks(change, [marked("gate", "plan.x", "not an object"), marked("stale", "Q1", { phases: "define" })]);
		expect(lock).toEqual({ locked: undefined, frozen: [], staleUnits: [], gates: {} });
	});
});

describe("gateDigest", () => {
	test("gateDigest ignores Questions and status lines", () => {
		const base = gateDigest(BODY);
		expect(base).toMatch(/^[0-9a-f]{64}$/);
		const answered = BODY.replace("- [ ] Q1 (blocking): Which header", "- [x] Q1 (blocking): Which header")
			.replace("\n## Units", "- [ ] Q3 (non-blocking): extra?\n\n## Units");
		expect(gateDigest(answered)).toBe(base);
		expect(gateDigest(BODY.replace("- [x] done", "- [ ] pending"))).toBe(base);
		expect(gateDigest(BODY.replace(/\n/g, "\r\n"))).toBe(base);
		expect(gateDigest(BODY.replace("Limit each client IP.", "Limit each client IP and user."))).not.toBe(base);
		expect(gateDigest(BODY.replace("Tags: [security, api]", "Tags: [api]"))).not.toBe(base);
	});
});
