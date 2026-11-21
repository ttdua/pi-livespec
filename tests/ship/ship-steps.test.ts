import { beforeAll, describe, expect, test } from "vitest";
import type { GateResult } from "../../src/engine/locks.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import type { ChangeState } from "../../src/engine/state-types.ts";
import { closeStep, prOutcomeStep, shipStep } from "../../src/ship/ship-steps.ts";
import { stateFor } from "../helpers/change-state.ts";

let pack: Pack;

beforeAll(async () => {
	const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
	if (!loaded.ok) throw new Error("default pack must load");
	pack = loaded.pack;
});

const HEAD = "f".repeat(40);
const OLD = "c".repeat(40);
type Pr = NonNullable<ChangeState["pr"]>;
const pr = (over: Partial<Pr> = {}): Pr => ({ number: 41, state: "open", merged: false, ...over });
const ship = (over: NonNullable<ChangeState["ship"]> = {}): NonNullable<ChangeState["ship"]> => ({ reviewed: true, needsShipGate: false, gatesAtHead: { review: true, ship: true }, ...over });
const approvedAt = (headSha: string): GateResult => ({ outcome: "approved", superseded: false, at: "t", waivers: [], notes: "", headSha, commentId: "g" });
const closedIssue = (phase: string) => ({ ...stateFor(phase).issue, state: "closed" as const });

describe("prOutcomeStep", () => {
	test("merged moves to close from any phase before close", () => {
		for (const phase of ["define", "build", "review", "ship"]) {
			expect(prOutcomeStep(stateFor(phase, { pr: pr({ state: "closed", merged: true }) }), pack)).toEqual({ next: "The pull request #41 is merged: move to close.", advance: "close" });
		}
	});

	test("closed unmerged asks to reopen or abandon", () => {
		expect(prOutcomeStep(stateFor("ship", { pr: pr({ state: "closed" }) }), pack)?.next).toBe(
			"The pull request #41 was closed without merge: reopen it on the forge, or abandon the change with change_close --abandon <reason>.",
		);
	});

	test("nothing for an open pull request, no pull request, a closed issue or the last phase", () => {
		expect(prOutcomeStep(stateFor("ship", { pr: pr() }), pack)).toBeUndefined();
		expect(prOutcomeStep(stateFor("ship"), pack)).toBeUndefined();
		expect(prOutcomeStep(stateFor("ship", { pr: pr({ state: "closed" }), issue: closedIssue("ship") }), pack)).toBeUndefined();
		expect(prOutcomeStep(stateFor("close", { pr: pr({ state: "closed", merged: true }) }), pack)).toBeUndefined();
	});
});

describe("shipStep", () => {
	test("only in ship", () => {
		expect(shipStep(stateFor("review", { pr: pr(), ship: ship() }), pack)).toBeUndefined();
	});

	test("HEAD not reviewed goes back to review", () => {
		expect(shipStep(stateFor("ship", { pr: pr({ pushedHead: OLD }), ship: ship({ reviewed: false }) }), pack)).toEqual({
			next: "New commits after the reviewed SHA need review: move to review.",
			advance: "review",
		});
	});

	test("no PR line leaves the gate to decide", () => {
		const body = stateFor("ship").change;
		const noPr = { ...body, header: { ...body.header, pr: undefined } };
		expect(shipStep(stateFor("ship", { change: noPr, ship: ship() }), pack)).toBeUndefined();
	});

	test("an unreadable pull request names it instead of guessing", () => {
		const out = shipStep(stateFor("ship", { ship: ship(), warnings: ["pull request #41 cannot be read: boom"] }), pack);
		expect(out?.next).toContain("#41");
		expect(out?.advance).toBeUndefined();
	});

	test("HEAD at the pushed head waits for the merge", () => {
		expect(shipStep(stateFor("ship", { pr: pr({ pushedHead: HEAD }), ship: ship() }), pack)).toEqual({ next: "Wait for a human to merge #41 on the forge." });
	});

	test("re-confirmation without a ship gate at HEAD is the ship gate", () => {
		const lock = { locked: undefined, frozen: [], staleUnits: [], gates: { ship: approvedAt(OLD) } };
		expect(shipStep(stateFor("ship", { pr: pr({ pushedHead: OLD }), lock, ship: ship({ needsShipGate: true, gatesAtHead: { review: true, ship: false } }) }), pack)).toEqual({ next: "Ready for the ship gate." });
	});

	test("re-confirmation shows the ship gate's own decision at HEAD", () => {
		const need = ship({ needsShipGate: true, gatesAtHead: { review: true, ship: false } });
		const at = (outcome: "changes_requested" | "dismissed") => stateFor("ship", { pr: pr({ pushedHead: OLD }), lock: { locked: undefined, frozen: [], staleUnits: [], gates: { ship: { ...approvedAt(HEAD), outcome, notes: "fix the docs" } } }, ship: need });
		expect(shipStep(at("changes_requested"), pack)?.next).toBe("The ship gate requested changes: revise, then request the gate again. Notes: fix the docs");
		expect(shipStep(at("dismissed"), pack)?.next).toBe("The ship gate was dismissed: ask the human how to proceed. Notes: fix the docs");
	});

	test("otherwise change_push", () => {
		expect(shipStep(stateFor("ship", { pr: pr({ pushedHead: OLD }), ship: ship() }), pack)).toEqual({ next: "Run change_push to update #41." });
		const lock = { locked: undefined, frozen: [], staleUnits: [], gates: { ship: approvedAt(HEAD) } };
		expect(shipStep(stateFor("ship", { pr: pr({ pushedHead: OLD }), lock, ship: ship({ needsShipGate: true }) }), pack)).toEqual({ next: "Run change_push to update #41." });
	});
});

describe("closeStep", () => {
	test("change_close while the issue is open, nothing once closed or outside close", () => {
		expect(closeStep(stateFor("close"), pack)).toEqual({ next: "Run change_close." });
		expect(closeStep(stateFor("close", { issue: closedIssue("close") }), pack)).toBeUndefined();
		expect(closeStep(stateFor("ship"), pack)).toBeUndefined();
	});
});
