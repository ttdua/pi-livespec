import { afterEach, describe, expect, test, vi } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { resetGatesForTests } from "../../src/engine/gates.ts";
import { deriveIterations } from "../../src/engine/iterations.ts";
import { REMOVED_DIGEST, requirementDigests, requirementScope } from "../../src/engine/requirement-diff.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { runSpecCascade } from "../../src/interaction/spec-cascade.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, type ToolHarness, toolHarness } from "../tools/helpers.ts";

afterEach(async () => {
	setSession(undefined);
	resetGatesForTests();
	await cleanupDirs();
});

const CAP = "rate-limit/Requirement: Per-IP cap";
const BURST = "rate-limit/Requirement: Burst";
const SPEC_PATH = "specs/rate-limit/spec.md";
const CAP_TEXT = "Each IP SHALL be capped.";
const BURST_TEXT = "Short spikes SHALL be absorbed.";
const GONE_SHA = "0123456789abcdef".repeat(2) + "01234567";
const LOCKED_AT = "2026-11-15T10:00:00.000Z";

const spec = (cap = CAP_TEXT, burst = BURST_TEXT): string =>
	["# rate-limit", "", "## Requirements", "### Requirement: Per-IP cap", cap, "", "#### Scenario: Capped", "- **WHEN** x", "- **THEN** y", "", "### Requirement: Burst", burst, "", "### Requirement: Window", "The window SHALL slide.", ""].join("\n");

type U = { id: string; requirement: string; done: boolean };

const block = (u: U): string =>
	[`### ${u.id} — Unit ${u.id}`, `Covers: rate-limit/Requirement: ${u.requirement}`, "Difficulty: low", "Tags: []", `Files: src/${u.id.toLowerCase()}.ts`, "Done means:", "- [a] works", "Scenarios:", `- [a] t.test.ts › ${u.id}`, "Depends: —", "Verify: `true`", u.done ? "- [x] done" : "- [ ] pending", ""].join("\n");

/** U4 is pending, so an all-done build does not advance to review on refresh. */
const UNITS: U[] = [
	{ id: "U1", requirement: "Window", done: true },
	{ id: "U2", requirement: "Burst", done: true },
	{ id: "U3", requirement: "Per-IP cap", done: true },
	{ id: "U4", requirement: "Per-IP cap", done: false },
];

const body = ["Depends: —", "Capabilities: new [], modified [rate-limit]", "Product impact: —", "", "## Proposal", "Limit.", "## Design", "Counter.", "## Questions", "", "## Units", ...UNITS.map(block), "## Durable docs", ""].join("\n");

/** Forge faults a test arms; each fires once. `ops` lists every mutation in order. */
type Faults = { ops: string[]; conflictOnce: boolean; commentFailsOnce: boolean; labelsFailOnce: boolean };

function faultyForge(inner: Forge, f: Faults): Forge {
	const wrapped: Partial<Forge> = {
		createComment: async (n, text) => {
			if (f.commentFailsOnce) {
				f.commentFailsOnce = false;
				throw new Error("injected createComment failure");
			}
			f.ops.push("comment");
			return inner.createComment(n, text);
		},
		updateIssueBody: async (n, text, version) => {
			if (f.conflictOnce) {
				f.conflictOnce = false;
				return { status: "conflict", current: version, changed: ["body"] };
			}
			f.ops.push("body");
			return inner.updateIssueBody(n, text, version);
		},
		addLabels: async (n, labels) => {
			if (f.labelsFailOnce) {
				f.labelsFailOnce = false;
				throw new Error("injected addLabels failure");
			}
			f.ops.push("labels");
			return inner.addLabels(n, labels);
		},
	};
	return new Proxy(inner, {
		get(target, prop) {
			if (prop in wrapped) return wrapped[prop as keyof Forge];
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

type H = ToolHarness & { faults: Faults };

/** The change in `build` on its branch, the spec committed at the harness HEAD, no lock yet. */
async function harness(phase = "build"): Promise<H> {
	const faults: Faults = { ops: [], conflictOnce: false, commentFailsOnce: false, labelsFailOnce: false };
	const h = await toolHarness({ change: { body, phase }, files: { [SPEC_PATH]: spec() }, forge: (world) => faultyForge(world.forge, faults) });
	return { ...h, faults };
}

const gateData = (h: H, headSha: string, record?: { requirements: Record<string, string>; requirement_scope: string[] }) => ({
	phase: "plan",
	outcome: "approved",
	notes: "",
	by: "alice",
	at: LOCKED_AT,
	adapter: "in-session",
	head_sha: headSha,
	waivers: [],
	locked: Object.fromEntries(parseChange(body).units.map((u) => [u.id, unitDigest(u)])),
	...(record ?? {}),
});

/** Seeds an approved plan gate at `headSha`, with the requirement record at the harness HEAD unless `legacy`. */
async function lock(h: H, o: { headSha?: string; legacy?: boolean } = {}): Promise<void> {
	const scope = requirementScope(parseChange(await h.world.bodyOf(h.n)));
	const record = o.legacy ? undefined : { requirements: await requirementDigests(h.session.git, h.head, scope), requirement_scope: scope };
	await h.world.postComment(h.n, BOT_LOGIN, writeMarked("gate", "plan.self-1", gateData(h, o.headSha ?? h.head, record)));
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
	h.faults.ops.length = 0;
}

async function editSpec(h: H, cap = CAP_TEXT, burst = BURST_TEXT): Promise<void> {
	await writeIn(h.root, SPEC_PATH, spec(cap, burst));
	commitAll(h.root, "spec edit");
}

const own = async (h: H): Promise<MarkedComment[]> => filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
const stales = async (h: H, prefix: string) => (await own(h)).filter((m) => m.kind === "stale" && m.id.startsWith(prefix));
const doneUnits = async (h: H) => parseChange(await h.world.bodyOf(h.n)).units.filter((u) => u.done).map((u) => u.id);
const phaseOf = async (h: H) => (await h.world.forge.getIssue(h.n)).labels.filter((l) => l.startsWith("livespec:phase/"));
const iterations = async (h: H) => deriveIterations(await own(h)).count;
const dataOf = (m: MarkedComment | undefined) => (m?.data ?? {}) as Record<string, unknown>;

/** Lands `files` on origin/main from the main branch, then returns to the change branch. */
async function mainEdits(h: H, files: Record<string, string>): Promise<string> {
	const branch = h.git("branch", "--show-current");
	h.git("switch", "-q", "main");
	for (const [path, text] of Object.entries(files)) await writeIn(h.root, path, text);
	commitAll(h.root, "main edit");
	h.git("push", "-q", "origin", "main");
	const tip = h.git("rev-parse", "HEAD");
	h.git("switch", "-q", branch);
	return tip;
}

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
		const withoutBurst = spec().replace(`### Requirement: Burst\n${BURST_TEXT}\n\n`, "");
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

