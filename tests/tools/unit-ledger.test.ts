// Evidence on the ledger across machines: a fresh clone sees what only origin holds, and an unknown
// ledger while offline refuses before any Verify runs (ledger-store: unit-evidence, ledger fetched before use).

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { unitDigest } from "../../src/core/digest.ts";
import { createLedger } from "../../src/ledger/index.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { cleanupDirs, textOf } from "./helpers.ts";
import { type UnitHarness, unitHarness } from "./unit-helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const SCRIPTS = { "check.sh": 'echo run >> "$LOG"\ntest -f src/u1.ts\n', "check2.sh": 'echo run >> "$LOG"\ntest -f src/u2.ts\n' };
const UNITS = [{ id: "U1", verify: "sh check.sh" }, { id: "U2", verify: "sh check2.sh", depends: ["U1"] }];

/** Makes this clone a fresh one: no local ledger, no tracking ref, and a ledger object that has fetched nothing. */
function forgetLedger(h: UnitHarness): void {
	for (const ref of [`refs/livespec/${h.n}`, `refs/livespec-origin/${h.n}`]) h.git("update-ref", "-d", ref);
	(h.session as { ledger: unknown }).ledger = createLedger(h.session.exec, h.root);
}

/** U1 started and received on this machine, ticked in the body, and pushed to origin. */
async function finishedU1OnOrigin(h: UnitHarness): Promise<void> {
	const u1 = (await h.units())[0]!;
	const sha = "a".repeat(40);
	await h.seed("unit-start", "U1.s", { unit: "U1", digest: unitDigest(u1), verify: u1.verify, pre: { sha, exit: 1, verdict: "red" }, });
	await h.seed("receipt", "U1.r", { unit: "U1", digest: unitDigest(u1), verify: u1.verify, pre: { sha, exit: 1 }, post: { sha, exit: 0 }, output: "", start: "U1.s" });
	await h.world.editBodyBehindBack(h.n, (await h.world.bodyOf(h.n)).replace("- [ ] pending", "- [x] done"));
	expect(await h.session.ledger.sync(h.n)).toEqual({ status: "synced" });
}

describe("unit-evidence on a second machine", () => {
	test("a receipt that exists only on origin lets U2 start on a fresh clone", async () => {
		const h = await unitHarness({ units: UNITS, scripts: SCRIPTS });
		await finishedU1OnOrigin(h);
		forgetLedger(h);
		const out = await h.start("U2");
		expect(out.isError, textOf(out)).toBeFalsy();
		const records = await h.marked();
		expect(records.filter((m) => m.kind === "receipt").map((m) => m.id)).toEqual(["U1.r"]);
		expect((await h.inLedger("unit-start")).map((m) => (m.data as { unit: string }).unit)).toEqual(["U1", "U2"]);
		expect(await h.commentsOf("unit-start")).toEqual([]);
	});

	test("Unknown ledger while offline: unit_start refuses, runs no Verify and writes nothing", async () => {
		const h = await unitHarness({ units: UNITS, scripts: SCRIPTS });
		await finishedU1OnOrigin(h);
		forgetLedger(h);
		h.git("remote", "set-url", "origin", join(tmpdir(), "ls-missing-origin", String(process.pid)));
		const comments = (await h.world.forge.listComments(h.n)).length;
		const out = await h.start("U2");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(`the ledger of #${h.n} could not be fetched; reconnect and retry`);
		expect(h.runs()).toBe(0);
		expect((await h.world.forge.listComments(h.n)).length).toBe(comments);
		expect((await h.session.ledger.read(h.n)).entries).toEqual([]);
	});
});
