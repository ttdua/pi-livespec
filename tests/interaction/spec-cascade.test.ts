import { afterEach, describe, expect, test, vi } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { resetGatesForTests } from "../../src/engine/gates.ts";
import { REMOVED_DIGEST, requirementDigests } from "../../src/engine/requirement-diff.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { runSpecCascade } from "../../src/interaction/spec-cascade.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import {
	BURST,
	burstBlock,
	CAP,
	CAP_TEXT,
	type CascadeHarness as H,
	cascadeHarness,
	dataOf,
	doneUnits,
	editSpec,
	GONE_SHA,
	iterations,
	lock,
	mainEdits,
	own,
	phaseOf,
	spec,
	SPEC_PATH,
	stales,
} from "../helpers/spec-cascade-fixture.ts";
import { cleanupDirs } from "../tools/helpers.ts";

afterEach(async () => {
	setSession(undefined);
	resetGatesForTests();
	await cleanupDirs();
});

/** The change in `phase` on its branch, the spec committed at the harness HEAD, no lock yet. */
const harness = (phase = "build"): Promise<H> => cascadeHarness({ phase });

describe("runSpecCascade", () => {
	test("applies stale, untick, move in order", async () => {
		const h = await harness();
		await lock(h);
		await editSpec(h, "Each IP SHALL be capped at 100.");
		expect(await runSpecCascade(h.session)).toBe(true);
		expect(h.faults.ops.slice(0, 3)).toEqual(["comment", "body", "labels"]);
		const [cascade] = await stales(h, "spec.");
		expect(dataOf(cascade)).toMatchObject({ units: ["U3", "U4"], after_plan: true, requirements: { [CAP]: expect.stringMatching(/^[0-9a-f]{64}$/) } });
		expect(await doneUnits(h)).toEqual(["U1", "U2"]);
		expect(await phaseOf(h)).toEqual(["livespec:phase/define"]);
		expect(await iterations(h)).toBe(1);
	});

	test("rerun at same HEAD writes nothing", async () => {
		const h = await harness();
		await lock(h);
		await editSpec(h, "Each IP SHALL be capped at 100.");
		await runSpecCascade(h.session);
		const before = (await own(h)).length;
		h.faults.ops.length = 0;
		expect(await runSpecCascade(h.session)).toBe(false);
		expect(h.faults.ops).toEqual([]);
		expect((await own(h)).length).toBe(before);
	});

	test("partial cascade plus a new edit are both applied in one run", async () => {
		const h = await harness();
		await lock(h);
		await editSpec(h, "Each IP SHALL be capped at 100.");
		h.faults.conflictOnce = true;
		await runSpecCascade(h.session);
		expect(await phaseOf(h)).toEqual(["livespec:phase/build"]);
		await editSpec(h, "Each IP SHALL be capped at 100.", "Spikes SHALL be absorbed.");
		expect(await runSpecCascade(h.session)).toBe(true);
		const cascades = await stales(h, "spec.");
		expect(cascades).toHaveLength(2);
		expect(dataOf(cascades[1])).toMatchObject({ units: ["U2"], after_plan: false, requirements: { [BURST]: expect.any(String) } });
		expect(await doneUnits(h)).toEqual(["U1"]);
		expect(await phaseOf(h)).toEqual(["livespec:phase/define"]);
		expect(await iterations(h)).toBe(1);
	});

	test("untick conflict then rerun completes", async () => {
		const h = await harness();
		await lock(h);
		await editSpec(h, "Each IP SHALL be capped at 100.");
		h.faults.conflictOnce = true;
		expect(await runSpecCascade(h.session)).toBe(true);
		expect(await doneUnits(h)).toEqual(["U1", "U2", "U3"]);
		expect(await phaseOf(h)).toEqual(["livespec:phase/build"]);
		await runSpecCascade(h.session);
		expect(await doneUnits(h)).toEqual(["U1", "U2"]);
		expect(await phaseOf(h)).toEqual(["livespec:phase/define"]);
		expect(await stales(h, "spec.")).toHaveLength(1);
		expect(await iterations(h)).toBe(1);
	});

	test("parallel calls share one run", async () => {
		const h = await harness();
		await lock(h);
		await editSpec(h, "Each IP SHALL be capped at 100.");
		expect(await Promise.all([runSpecCascade(h.session), runSpecCascade(h.session)])).toEqual([true, true]);
		expect(await stales(h, "spec.")).toHaveLength(1);
		expect(await iterations(h)).toBe(1);
	});

	test("rebased branch, lock commit gone, nothing changed → nothing written", async () => {
		const h = await harness();
		await lock(h, { headSha: GONE_SHA });
		expect(await h.session.git.hasCommit(GONE_SHA)).toBe(false);
		expect(await runSpecCascade(h.session)).toBe(false);
		expect(h.faults.ops).toEqual([]);
		expect(await phaseOf(h)).toEqual(["livespec:phase/build"]);
	});

	test("rebased branch, lock commit gone, edit → cascade", async () => {
		const h = await harness();
		await lock(h, { headSha: GONE_SHA });
		await editSpec(h, "Each IP SHALL be capped at 100.");
		expect(await runSpecCascade(h.session)).toBe(true);
		const [cascade] = await stales(h, "spec.");
		expect(dataOf(cascade)).toMatchObject({ units: ["U3", "U4"], requirements: { [CAP]: expect.any(String) } });
		expect(await doneUnits(h)).toEqual(["U1", "U2"]);
		expect(await phaseOf(h)).toEqual(["livespec:phase/define"]);
		expect(await stales(h, "baseline.")).toEqual([]);
	});

	test("own edit reverted to the lock text cascades although main never touched it", async () => {
		const h = await harness();
		await lock(h);
		await editSpec(h, "Each IP SHALL be capped at 100.");
		await runSpecCascade(h.session);
		await editSpec(h);
		expect(await runSpecCascade(h.session)).toBe(true);
		const cascades = await stales(h, "spec.");
		expect(cascades).toHaveLength(2);
		const original = (await requirementDigests(h.session.git, h.head, ["rate-limit"]))[CAP];
		expect(dataOf(cascades[1]).requirements).toEqual({ [CAP]: original });
	});

	test("hand merge of main ignored", async () => {
		const h = await harness();
		await lock(h);
		await mainEdits(h, { [SPEC_PATH]: spec(CAP_TEXT, "Spikes SHALL be absorbed by main.") });
		h.git("merge", "-q", "--no-edit", "origin/main");
		expect(await runSpecCascade(h.session)).toBe(false);
		expect(h.faults.ops).toEqual([]);
		expect(await doneUnits(h)).toEqual(["U1", "U2", "U3"]);
		expect(await phaseOf(h)).toEqual(["livespec:phase/build"]);
		expect(parseChange(await h.world.bodyOf(h.n)).header.base).toBe(h.head);
	});

	test("conflict combined from both sides cascades", async () => {
		const h = await harness();
		await lock(h);
		await mainEdits(h, { [SPEC_PATH]: spec("Each IP SHALL be capped by main.") });
		await editSpec(h, "Each IP SHALL be capped by the change.");
		expect(() => h.git("merge", "-q", "--no-edit", "origin/main")).toThrow();
		await writeIn(h.root, SPEC_PATH, spec("Each IP SHALL be capped by main and the change."));
		commitAll(h.root, "merge");
		expect(await runSpecCascade(h.session)).toBe(true);
		const [cascade] = await stales(h, "spec.");
		expect(Object.keys(dataOf(cascade).requirements as object)).toEqual([CAP]);
	});

	test("stale origin ref still excludes after the fetch", async () => {
		const h = await harness();
		await lock(h);
		const tip = await mainEdits(h, { [SPEC_PATH]: spec(CAP_TEXT, "Spikes SHALL be absorbed by main.") });
		// The local tracking ref lags behind origin: only the fetch brings it to the tip HEAD merged.
		h.git("update-ref", "refs/remotes/origin/main", h.head);
		h.git("merge", "-q", "--no-edit", tip);
		expect(await runSpecCascade(h.session)).toBe(false);
		expect(h.git("rev-parse", "origin/main")).toBe(tip);
		expect(await stales(h, "spec.")).toEqual([]);
	});

	test("exclusion falls back to Base without origin ref, and when merge-base fails", async () => {
		const h = await harness();
		await lock(h);
		const tip = await mainEdits(h, { [SPEC_PATH]: spec(CAP_TEXT, "Spikes SHALL be absorbed by main.") });
		h.git("merge", "-q", "--no-edit", "origin/main");
		// change_sync moved Base to the merged tip; then the remote goes away.
		await h.world.editBodyBehindBack(h.n, (await h.world.bodyOf(h.n)).replace(`Base: ${h.head}`, `Base: ${tip}`));
		h.git("remote", "remove", "origin");
		expect(await runSpecCascade(h.session)).toBe(false);
		expect(await stales(h, "spec.")).toEqual([]);
		h.git("remote", "add", "origin", h.origin);
		h.git("fetch", "-q", "origin");
		Object.assign(h.session.git, {
			mergeBase: async () => {
				throw new Error("merge-base failed");
			},
		});
		expect(await runSpecCascade(h.session)).toBe(false);
		expect(await stales(h, "spec.")).toEqual([]);
		expect(h.session.errors.filter((e) => e.startsWith("spec-cascade"))).toEqual([]);
	});

	test("legacy lock with commit present → compares from it", async () => {
		const h = await harness();
		// The lock commit is no longer an ancestor of HEAD but still in the object store.
		h.git("switch", "-q", "-c", "side");
		h.git("commit", "-q", "--allow-empty", "-m", "side");
		const side = h.git("rev-parse", "HEAD");
		h.git("switch", "-q", "-");
		h.git("branch", "-q", "-D", "side");
		await lock(h, { headSha: side, legacy: true });
		expect(await runSpecCascade(h.session)).toBe(false);
		await editSpec(h, "Each IP SHALL be capped at 100.");
		expect(await runSpecCascade(h.session)).toBe(true);
		expect(Object.keys(dataOf((await stales(h, "spec."))[0]).requirements as object)).toEqual([CAP]);
		expect(await stales(h, "baseline.")).toEqual([]);
	});

	test("legacy lock with commit gone → define", async () => {
		const h = await harness();
		await lock(h, { headSha: GONE_SHA, legacy: true });
		expect(await runSpecCascade(h.session)).toBe(true);
		const records = await stales(h, "baseline.");
		expect(records).toHaveLength(1);
		expect(records[0]?.id).toBe(`baseline.${GONE_SHA.slice(0, 12)}`);
		expect(dataOf(records[0])).toMatchObject({ phases: ["define", "plan", "build", "review", "ship", "close"], units: [], after_plan: false });
		expect(await phaseOf(h)).toEqual(["livespec:phase/define"]);
		expect(await doneUnits(h)).toEqual(["U1", "U2", "U3"]);
		expect(await iterations(h)).toBe(0);
	});

	test("legacy move failure then rerun moves to define", async () => {
		const h = await harness();
		await lock(h, { headSha: GONE_SHA, legacy: true });
		h.faults.labelsFailOnce = true;
		expect(await runSpecCascade(h.session)).toBe(true);
		expect(await phaseOf(h)).toEqual(["livespec:phase/build"]);
		expect(h.session.errors.some((e) => e.startsWith("spec-cascade") && e.includes("injected addLabels failure"))).toBe(true);
		await runSpecCascade(h.session);
		expect(await phaseOf(h)).toEqual(["livespec:phase/define"]);
		expect(await stales(h, "baseline.")).toHaveLength(1);
	});

	test("read-only forge skips", async () => {
		const h = await harness();
		await lock(h);
		await editSpec(h, "Each IP SHALL be capped at 100.");
		await h.world.makeUnreachable();
		await expect(h.forge.listComments(h.n)).rejects.toThrow();
		await h.world.restore();
		expect(h.forge.isReadOnly()).toBe(true);
		expect(await runSpecCascade(h.session)).toBe(false);
		expect(h.faults.ops).toEqual([]);
		expect(await stales(h, "spec.")).toEqual([]);
	});

	test("failure is recorded, not thrown", async () => {
		const h = await harness();
		await lock(h);
		await editSpec(h, "Each IP SHALL be capped at 100.");
		const record = vi.spyOn(h.session, "record");
		h.faults.commentFailsOnce = true;
		await expect(runSpecCascade(h.session)).resolves.toBe(false);
		expect(record).toHaveBeenCalledWith("spec-cascade", expect.anything());
		expect(await doneUnits(h)).toEqual(["U1", "U2", "U3"]);
	});

	test("unchanged spec makes no fetch", async () => {
		const h = await harness();
		await lock(h);
		const fetch = vi.fn(h.session.git.fetch);
		Object.assign(h.session.git, { fetch });
		expect(await runSpecCascade(h.session)).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("refresh failure after a write still returns true and is recorded", async () => {
		const h = await harness();
		await lock(h);
		await editSpec(h, "Each IP SHALL be capped at 100.");
		vi.spyOn(h.session, "refresh").mockRejectedValueOnce(new Error("injected refresh failure"));
		expect(await runSpecCascade(h.session)).toBe(true);
		expect(h.session.errors.some((e) => e.startsWith("spec-cascade") && e.includes("injected refresh failure"))).toBe(true);
		expect(await stales(h, "spec.")).toHaveLength(1);
	});

	test("removed requirement cascades once with REMOVED_DIGEST through the forge record", async () => {
		const h = await harness();
		await lock(h);
		const withoutBurst = spec().replace(burstBlock(), "");
		await writeIn(h.root, SPEC_PATH, withoutBurst);
		commitAll(h.root, "remove Burst");
		expect(await runSpecCascade(h.session)).toBe(true);
		const [cascade] = await stales(h, "spec.");
		expect(dataOf(cascade)).toMatchObject({ units: ["U2"], requirements: { [BURST]: REMOVED_DIGEST } });
		expect(await doneUnits(h)).toEqual(["U1", "U3"]);
		h.faults.ops.length = 0;
		expect(await runSpecCascade(h.session)).toBe(false);
		expect(h.faults.ops).toEqual([]);
		expect(await stales(h, "spec.")).toHaveLength(1);
	});

	test("no lock → nothing written", async () => {
		const h = await harness("plan");
		await editSpec(h, "Each IP SHALL be capped at 100.");
		expect(await runSpecCascade(h.session)).toBe(false);
		expect(h.faults.ops).toEqual([]);
	});
});

