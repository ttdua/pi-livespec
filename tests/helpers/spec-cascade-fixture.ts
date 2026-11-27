// The spec-diff cascade fixture shared by the cascade's integration and end-to-end tests: a change in `build`
// on its branch whose `rate-limit` spec passes every define check, a forge with one-shot faults, and the
// helpers that seed the plan lock and read what the cascade wrote.

import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import type { Git } from "../../src/engine/git.ts";
import { deriveIterations } from "../../src/engine/iterations.ts";
import { requirementDigests, requirementScope } from "../../src/engine/requirement-diff.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import type { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { commitAll, writeIn } from "./repo.ts";
import { type ToolHarness, type ToolHarnessOptions, toolHarness } from "../tools/helpers.ts";

export const CAP = "rate-limit/Requirement: Per-IP cap";
export const BURST = "rate-limit/Requirement: Burst";
export const WINDOW = "rate-limit/Requirement: Window";
export const SPEC_PATH = "specs/rate-limit/spec.md";
export const CAP_TEXT = "Each IP SHALL be capped.";
export const BURST_TEXT = "Short spikes SHALL be absorbed.";
export const GONE_SHA = "0123456789abcdef".repeat(2) + "01234567";
const LOCKED_AT = "2026-11-15T10:00:00.000Z";

const requirement = (name: string, text: string): string[] => [`### Requirement: ${name}`, text, "", `#### Scenario: ${name} holds`, "- **WHEN** x", "- **THEN** y", ""];

/** The Burst requirement block as `spec` writes it, so a test can delete it. */
export const burstBlock = (burst = BURST_TEXT): string => requirement("Burst", burst).join("\n");

/** A valid `rate-limit` spec: every requirement has a scenario. */
export const spec = (cap = CAP_TEXT, burst = BURST_TEXT): string =>
	["# rate-limit", "", "## Requirements", ...requirement("Per-IP cap", cap), ...requirement("Burst", burst), ...requirement("Window", "The window SHALL slide.")].join("\n");

export type U = { id: string; requirement: string; done: boolean; verify?: string; capability?: string };

export const block = (u: U): string =>
	[
		`### ${u.id} — Unit ${u.id}`,
		`Covers: ${u.capability ?? "rate-limit"}/Requirement: ${u.requirement}`,
		"Difficulty: low",
		"Tags: []",
		`Files: src/${u.id.toLowerCase()}.ts`,
		"Done means:",
		"- [a] works",
		"Scenarios:",
		`- [a] t.test.ts › ${u.id}`,
		"Depends: —",
		`Verify: \`${u.verify ?? "true"}\``,
		u.done ? "- [x] done" : "- [ ] pending",
		"",
	].join("\n");

/** U4 is pending, so an all-done build does not advance to review on refresh. */
export const UNITS: U[] = [
	{ id: "U1", requirement: "Window", done: true },
	{ id: "U2", requirement: "Burst", done: true },
	{ id: "U3", requirement: "Per-IP cap", done: true },
	{ id: "U4", requirement: "Per-IP cap", done: false },
];

/** The change body after `Base:` and `Branch:`; `header` adds lines such as `Initiative: #2` first. */
export const changeBody = (units: U[] = UNITS, header: string[] = []): string =>
	[...header, "Depends: —", "Capabilities: new [], modified [rate-limit]", "Product impact: none — test fixture", "", "## Proposal", "Limit.", "## Design", "Counter.", "## Questions", "", "## Units", ...units.map(block), "## Durable docs", ""].join("\n");

/** Forge faults a test arms; each fires once. `ops` lists every mutation in order. */
export type Faults = { ops: string[]; conflictOnce: boolean; commentFailsOnce: boolean; labelsFailOnce: boolean };

export const noFaults = (): Faults => ({ ops: [], conflictOnce: false, commentFailsOnce: false, labelsFailOnce: false });

export function faultyForge(inner: Forge, f: Faults): Forge {
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

export type CascadeHarness = ToolHarness & { faults: Faults };

export type CascadeHarnessOptions = { phase?: string; units?: U[]; header?: string[]; files?: Record<string, string>; ui?: ToolHarnessOptions["ui"]; config?: string };

/** The change on its branch, the spec committed at the harness HEAD (also on `main`), no lock yet. */
export async function cascadeHarness(o: CascadeHarnessOptions = {}): Promise<CascadeHarness> {
	const faults = noFaults();
	const h = await toolHarness({
		change: { body: changeBody(o.units, o.header), phase: o.phase ?? "build" },
		files: { [SPEC_PATH]: spec(), ...o.files },
		forge: (world) => faultyForge(world.forge, faults),
		...(o.ui === undefined ? {} : { ui: o.ui }),
		...(o.config === undefined ? {} : { config: o.config }),
	});
	return { ...h, faults };
}

export type LockOptions = { headSha?: string; legacy?: boolean; scope?: string[] };

/**
 * Posts an approved plan gate locking the issue's units, bound to `headSha` (default HEAD); unless `legacy`,
 * it records the requirement digests at HEAD for `scope` (default the change's scope).
 */
export async function seedLock(world: MemoryWorld, n: number, git: Git, o: LockOptions = {}): Promise<void> {
	const change = parseChange(await world.bodyOf(n));
	const scope = o.scope ?? requirementScope(change);
	const head = await git.head();
	const record = o.legacy ? {} : { requirements: await requirementDigests(git, head, scope), requirement_scope: scope };
	const locked = Object.fromEntries(change.units.map((u) => [u.id, unitDigest(u)]));
	const data = { phase: "plan", outcome: "approved", notes: "", by: "alice", at: LOCKED_AT, adapter: "in-session", head_sha: o.headSha ?? head, waivers: [], locked, ...record };
	const count = (await world.forge.listComments(n)).length;
	await world.postComment(n, BOT_LOGIN, writeMarked("gate", `plan.self-${count + 1}`, data));
}

/** Posts an own marked comment as another session would, then drops the comments cache and refreshes. */
export async function seedOwn(h: CascadeHarness, kind: string, id: string, data: unknown): Promise<void> {
	await h.world.postComment(h.n, BOT_LOGIN, writeMarked(kind, id, data));
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
}

/** Seeds the plan lock and refreshes; the fault log starts empty after it. */
export async function lock(h: CascadeHarness, o: LockOptions = {}): Promise<void> {
	await seedLock(h.world, h.n, h.session.git, o);
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
	h.faults.ops.length = 0;
}

export async function editSpec(h: ToolHarness, cap = CAP_TEXT, burst = BURST_TEXT): Promise<void> {
	await writeIn(h.root, SPEC_PATH, spec(cap, burst));
	commitAll(h.root, "spec edit");
}

export const own = async (h: ToolHarness): Promise<MarkedComment[]> => filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
export const stales = async (h: ToolHarness, prefix: string) => (await own(h)).filter((m) => m.kind === "stale" && m.id.startsWith(prefix));
export const doneUnits = async (h: ToolHarness) => parseChange(await h.world.bodyOf(h.n)).units.filter((u) => u.done).map((u) => u.id);
export const phaseOf = async (h: ToolHarness) => (await h.world.forge.getIssue(h.n)).labels.filter((l) => l.startsWith("livespec:phase/"));
export const iterations = async (h: ToolHarness) => deriveIterations(await own(h)).count;
export const dataOf = (m: MarkedComment | undefined) => (m?.data ?? {}) as Record<string, unknown>;

/** Lands `files` on origin/main from the main branch, then returns to the change branch. */
export async function mainEdits(h: ToolHarness, files: Record<string, string>): Promise<string> {
	const branch = h.git("branch", "--show-current");
	h.git("switch", "-q", "main");
	for (const [path, text] of Object.entries(files)) await writeIn(h.root, path, text);
	commitAll(h.root, "main edit");
	h.git("push", "-q", "origin", "main");
	const tip = h.git("rev-parse", "HEAD");
	h.git("switch", "-q", branch);
	return tip;
}
