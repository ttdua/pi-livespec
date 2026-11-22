import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { resetGatesForTests } from "../../src/engine/gates.ts";
import "../../src/initiatives/facts.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { runChangeSync } from "../../src/tools/change-sync.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { fakeCtx } from "../hooks/fake-pi.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "./helpers.ts";
import { cardState } from "./unit-helpers.ts";

afterEach(async () => {
	setSession(undefined);
	resetGatesForTests();
	await cleanupDirs();
});

type U = { id: string; requirement: string; script: string; done: boolean };

const block = (u: U): string =>
	[
		`### ${u.id} — Unit ${u.id}`,
		`Covers: rate-limit/Requirement: ${u.requirement}`,
		"Difficulty: low",
		"Tags: []",
		`Files: src/${u.id.toLowerCase()}.ts`,
		"Done means:",
		"- [a] works",
		"Scenarios:",
		`- [a] test/${u.id.toLowerCase()}.test.ts › works`,
		"Depends: —",
		`Verify: \`sh ${u.script}\``,
		u.done ? "- [x] done" : "- [ ] pending",
	].join("\n");

/** Initiative #2 lists this change (#1) and a sibling #9; the sibling's entry is checked unless `siblingChecked` is false. */
const INITIATIVE = 2;
const body = (units: U[]): string =>
	[
		`Initiative: #${INITIATIVE}`,
		"Depends: —",
		"Capabilities: new [], modified [rate-limit]",
		"Product impact: —",
		"",
		"## Proposal",
		"Limit each client IP.",
		"## Design",
		"Counter.",
		"## Questions",
		"",
		"## Units",
		...units.flatMap((u) => [block(u), ""]),
		"## Durable docs",
		"",
	].join("\n");

const spec = (capText: string): string =>
	["# rate-limit", "", "## Purpose", "Limits.", "", "## Requirements", "### Requirement: Per-IP cap", capText, "", "#### Scenario: Capped", "- **WHEN** x", "- **THEN** y", "", "### Requirement: Window", "The window SHALL slide.", "", "#### Scenario: Slides", "- **WHEN** x", "- **THEN** y", ""].join("\n");

const UNITS: U[] = [
	{ id: "U1", requirement: "Per-IP cap", script: "u1.sh", done: true },
	{ id: "U2", requirement: "Window", script: "u2.sh", done: true },
];

/** A pending unit that keeps the change in build (an all-done build advances to review on refresh). */
const PENDING_U3: U = { id: "U3", requirement: "Window", script: "u1.sh", done: false };

const FILES = {
	"u1.sh": "exit 0\n",
	// Red once the sibling's file is on the branch.
	"u2.sh": "test ! -f sibling.txt\n",
	"specs/rate-limit/spec.md": spec("Each IP SHALL be capped."),
};

async function harness(o: { phase?: string; siblingChecked?: boolean; units?: U[] } = {}): Promise<ToolHarness> {
	const h = await toolHarness({ change: { body: body(o.units ?? UNITS), phase: o.phase ?? "build" }, locked: true, files: FILES });
	const tracking = await h.world.seedIssue({
		title: "limits",
		body: `Goal: Limit\nCapabilities: [rate-limit]\n\n## Changes\n- [${o.siblingChecked === false ? " " : "x"}] #9 audit-log — Depends: —\n- [ ] #${h.n} per-ip-cap — Depends: —\n`,
		labels: ["livespec:initiative"],
	});
	expect(tracking).toBe(INITIATIVE);
	await h.session.refresh();
	return h;
}

/** Lands `files` on origin/main as the sibling's merge, then refreshes; returns the new tip. */
async function siblingMerges(h: ToolHarness, files: Record<string, string>): Promise<string> {
	const branch = h.git("branch", "--show-current");
	h.git("switch", "-q", "main");
	for (const [path, text] of Object.entries(files)) await writeIn(h.root, path, text);
	commitAll(h.root, "sibling #9");
	h.git("push", "-q", "origin", "main");
	h.git("switch", "-q", branch);
	await h.session.refresh();
	return h.git("rev-parse", "origin/main");
}

const own = async (h: ToolHarness): Promise<MarkedComment[]> => filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
const ofKind = async (h: ToolHarness, kind: string) => (await own(h)).filter((m) => m.kind === kind);
const header = async (h: ToolHarness) => parseChange(await h.world.bodyOf(h.n)).header;
const doneUnits = async (h: ToolHarness) => parseChange(await h.world.bodyOf(h.n)).units.filter((u) => u.done).map((u) => u.id);
const labels = async (h: ToolHarness) => (await h.world.forge.getIssue(h.n)).labels;

describe("change_sync", () => {
	test("Sibling merged", async () => {
		const h = await harness({ units: [...UNITS, PENDING_U3] });
		expect(cardState(h).step.next).not.toContain("change_sync");
		await siblingMerges(h, { "other.txt": "o\n" });
		expect(cardState(h).state.deps).toMatchObject({ siblingMerged: true, integrationAhead: true });
		expect(cardState(h).step.phase).toBe("build");
		expect(cardState(h).step.next).toContain("change_sync");
	});

	test("no sync step while no sibling entry is checked", async () => {
		const h = await harness({ siblingChecked: false });
		await siblingMerges(h, { "other.txt": "o\n" });
		expect(cardState(h).state.deps).toMatchObject({ siblingMerged: false, integrationAhead: true });
		expect(cardState(h).step.next).not.toContain("change_sync");
	});

	test("Regression receipts", async () => {
		const h = await harness();
		const oldBase = (await header(h)).base;
		const tip = await siblingMerges(h, { "other.txt": "o\n" });
		const out = await h.call("change_sync");
		expect(out.isError, textOf(out)).toBeFalsy();
		const head = h.git("rev-parse", "HEAD");
		const records = await ofKind(h, "regression");
		expect(records).toHaveLength(1);
		expect(records[0]?.id).toBe(`regression.${head}`);
		expect(records[0]?.data).toMatchObject({
			base_from: oldBase,
			base_to: tip,
			head,
			units: [
				{ unit: "U1", exit: 0, verdict: "green" },
				{ unit: "U2", exit: 0, verdict: "green" },
			],
		});
		expect((await header(h)).base).toBe(tip);
		expect(h.git("config", "--get", "branch.livespec/per-ip-cap.livespecBase")).toBe(tip);
		expect(h.git("merge-base", "--is-ancestor", "origin/main", "HEAD")).toBe("");
		expect(await doneUnits(h)).toEqual(["U1", "U2"]);
		expect(await ofKind(h, "stale")).toEqual([]);
		expect(out.details).toEqual({ base: tip, stale: [] });
		expect(cardState(h).step.next).not.toContain("change_sync");
	});

	test("Failing unit after the merge", async () => {
		const h = await harness({ units: [...UNITS, PENDING_U3] });
		expect(await labels(h)).toContain("livespec:phase/build");
		await siblingMerges(h, { "sibling.txt": "s\n" });
		const out = await h.call("change_sync");
		expect(out.isError, textOf(out)).toBeFalsy();
		expect((await ofKind(h, "regression"))[0]?.data).toMatchObject({ units: [{ unit: "U1", verdict: "green" }, { unit: "U2", verdict: "red", exit: 1 }] });
		expect(await doneUnits(h)).toEqual(["U1"]);
		expect(await labels(h)).toContain("livespec:phase/build");
		const stale = await ofKind(h, "stale");
		expect(stale).toHaveLength(1);
		expect(stale[0]?.data).toMatchObject({ units: ["U2"], phases: [], after_plan: false });
		expect(out.details).toMatchObject({ stale: ["U2"] });
		expect(cardState(h).step.next).toMatch(/Amend U2 with unit_amend/);
	});

	test("Regression during review", async () => {
		const h = await harness({ phase: "review" });
		await siblingMerges(h, { "sibling.txt": "s\n" });
		const out = await h.call("change_sync");
		expect(out.isError, textOf(out)).toBeFalsy();
		const stale = await ofKind(h, "stale");
		expect(stale[0]?.data).toMatchObject({ units: ["U2"], phases: ["review", "ship", "close"], after_plan: false });
		expect(await labels(h)).toContain("livespec:phase/build");
		expect(await labels(h)).not.toContain("livespec:phase/review");
		expect(await doneUnits(h)).toEqual(["U1"]);
	});

	test("a clean sync during review keeps the phase", async () => {
		const h = await harness({ phase: "review" });
		await siblingMerges(h, { "other.txt": "o\n" });
		expect((await h.call("change_sync")).isError).toBeFalsy();
		expect(await labels(h)).toContain("livespec:phase/review");
		expect(await ofKind(h, "stale")).toEqual([]);
	});

	test("Conflict", async () => {
		const h = await harness();
		await writeIn(h.root, "README.md", "change\n");
		commitAll(h.root, "change edit");
		const head = h.git("rev-parse", "HEAD");
		const before = (await header(h)).base;
		await siblingMerges(h, { "README.md": "sibling\n" });
		const out = await h.call("change_sync");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("Merge origin/main by hand");
		expect(h.git("rev-parse", "HEAD")).toBe(head);
		expect((await header(h)).base).toBe(before);
		expect(h.git("status", "--porcelain")).toBe("");
		expect(h.git("status")).not.toContain("merging");
		expect(await ofKind(h, "regression")).toEqual([]);
	});

	test("a requirement covered by a green unit that changed between the bases makes it stale", async () => {
		const h = await harness();
		await siblingMerges(h, { "specs/rate-limit/spec.md": spec("Each IP SHALL be capped at 100 requests.") });
		const out = await h.call("change_sync");
		expect(out.isError, textOf(out)).toBeFalsy();
		expect((await ofKind(h, "regression"))[0]?.data).toMatchObject({ units: [{ unit: "U1", verdict: "green" }, { unit: "U2", verdict: "green" }] });
		expect(await doneUnits(h)).toEqual(["U2"]);
		expect((await ofKind(h, "stale"))[0]?.data).toMatchObject({ units: ["U1"] });
	});

	test("refuses on a dirty tree or off the change branch", async () => {
		const h = await harness();
		await siblingMerges(h, { "other.txt": "o\n" });
		await writeIn(h.root, "scratch.txt", "x\n");
		expect(textOf(await h.call("change_sync"))).toContain("uncommitted changes");
		h.git("clean", "-fdq");
		h.git("switch", "-q", "-c", "elsewhere");
		await h.session.refresh();
		const off = await h.call("change_sync");
		expect(off.isError).toBe(true);
		expect(await ofKind(h, "regression")).toEqual([]);
	});

	test("refuses with a started unit", async () => {
		const h = await harness({ units: [...UNITS, PENDING_U3] });
		await siblingMerges(h, { "other.txt": "o\n" });
		const sha = h.git("rev-parse", "HEAD");
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("unit-start", "U3.1", { unit: "U3", digest: "d", verify: "sh u1.sh", pre: { sha, exit: 1, verdict: "red" } }));
		await h.session.comments?.invalidate(h.n);
		const out = await h.call("change_sync");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("U3 is started");
		expect(await ofKind(h, "regression")).toEqual([]);
	});

	test("refuses in a child session", async () => {
		const h = await harness();
		const child = { ...fakeCtx(h.root, true), sessionManager: { getHeader: () => ({ parentSession: "p" }) } } as never;
		const out = await runChangeSync(child);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("child session");
	});
});
