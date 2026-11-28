import { describe, expect, test } from "vitest";
import { type GitExec, defaultGitExec } from "../../src/engine/git-exec.ts";
import { createGit } from "../../src/engine/git.ts";
import { Session } from "../../src/hooks/session.ts";
import type { GateResult, LockState } from "../../src/engine/locks.ts";
import type { ChangeState } from "../../src/engine/state-types.ts";
import type { MarkedComment } from "../../src/forge/markers.ts";
import { type ShipContext, shipContext } from "../../src/ship/context.ts";
import { confirmationSection } from "../../src/ship/durable-check.ts";
import { durableDocsRule } from "../../src/ship/durable-docs.ts";
import { type DecisionRecord, decisionComment } from "../../src/decide/records.ts";
import { parseMarked } from "../../src/forge/markers.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { stateFor } from "../helpers/change-state.ts";
import { type Fixture, fixture, sh, upstreamCommit } from "./repo.ts";

describe("shipContext", () => {
	test("two calls at the same HEAD fetch once", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "specs/glossary.md", "g\n");
		commitAll(f.work, "doc");
		const calls: string[][] = [];
		const exec: GitExec = (args, opts) => {
			calls.push(args);
			return defaultGitExec(args, opts);
		};
		const session = new Session(f.work, createGit(f.work, exec), exec);
		session.config = { ...session.config, project: { githubHosts: [], agentSkillsChannelSet: false, integrationBranch: "main" } };
		const head = sh(f.work, "rev-parse", "HEAD");
		const state = stateFor("ship", { git: { branch: "feature", head, dirty: false, specsChanged: true } }, `Base: ${base}\nBranch: feature\nCapabilities: new [], modified []\n\n## Durable docs\n`);
		const a = await shipContext(session, state);
		const b = await shipContext(session, state);
		expect(calls.filter((c) => c[0] === "fetch")).toHaveLength(1);
		expect(a).toMatchObject({ diff: { files: ["specs/glossary.md"] }, integrationTip: base, facts: { files: ["specs/glossary.md"] } });
		expect(b).toEqual(a);
	});

	test("a new HEAD fetches again", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		const calls: string[][] = [];
		const exec: GitExec = (args, opts) => {
			calls.push(args);
			return defaultGitExec(args, opts);
		};
		const session = new Session(f.work, createGit(f.work, exec), exec);
		session.config = { ...session.config, project: { githubHosts: [], agentSkillsChannelSet: false, integrationBranch: "main" } };
		const at = (head: string) => stateFor("ship", { git: { branch: "feature", head, dirty: false, specsChanged: true } }, `Base: ${base}\nBranch: feature\n\n## Durable docs\n`);
		await shipContext(session, at(base));
		await writeIn(f.work, "a.ts", "a\n");
		commitAll(f.work, "a");
		await shipContext(session, at(sh(f.work, "rev-parse", "HEAD")));
		expect(calls.filter((c) => c[0] === "fetch")).toHaveLength(2);
	});

	test("without a project config the context is refused", async () => {
		const f = await fixture();
		const session = new Session(f.work, f.git);
		const out = await shipContext(session, stateFor("ship"));
		expect(out).toHaveProperty("refused");
	});
});

// --- refresh facts: reviewed, gatesAtHead, needsShipGate (design D9, D3) ---------

const approved = (headSha: string): GateResult => ({ outcome: "approved", superseded: false, at: "t", waivers: [], notes: "", headSha, commentId: "g1" });

async function shipSession(work: string): Promise<Session> {
	const session = new Session(work, createGit(work));
	session.config = { ...session.config, project: { githubHosts: [], agentSkillsChannelSet: false, integrationBranch: "main" } };
	return session;
}

type At = { review?: string; ship?: string; pushedHead?: string; marked?: MarkedComment[]; body?: string };

function shipState(work: string, base: string, at: At): ChangeState {
	const head = sh(work, "rev-parse", "HEAD");
	const gates: LockState["gates"] = {};
	if (at.review !== undefined) gates.review = approved(at.review);
	if (at.ship !== undefined) gates.ship = approved(at.ship);
	return stateFor(
		"ship",
		{
			git: { branch: "feature", head, dirty: false, specsChanged: true },
			lock: { locked: undefined, frozen: [], staleUnits: [], gates },
			marked: at.marked ?? [],
			pr: { number: 41, state: "open", merged: false, ...(at.pushedHead === undefined ? {} : { pushedHead: at.pushedHead }) },
		},
		at.body ?? `Base: ${base}\nBranch: feature\nPR: #41\nCapabilities: new [], modified []\n\n## Durable docs\n`,
	);
}

const shipRecord = (pushedHead: string, confirmed: string[]): MarkedComment => ({
	commentId: `s-${pushedHead}`,
	kind: "ship",
	id: `ship.41.${pushedHead}`,
	author: "bot",
	data: { pr: 41, pushedHead, confirmed },
});

async function ctx(session: Session, state: ChangeState): Promise<ShipContext> {
	const out = await shipContext(session, state);
	if ("refused" in out) throw new Error(out.refused);
	return out;
}

describe("shipContext refresh facts", () => {
	test("reviewed and gatesAtHead are true at the reviewed SHA", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "src/a.ts", "a\n");
		commitAll(f.work, "c3");
		const c3 = sh(f.work, "rev-parse", "HEAD");
		const out = await ctx(await shipSession(f.work), shipState(f.work, base, { review: c3, ship: c3, pushedHead: c3 }));
		expect(out.reviewed).toEqual({ ok: true });
		expect(out.gatesAtHead).toEqual({ review: true, ship: true });
		expect(out.needsShipGate).toBe(false);
	});

	test("a fix commit makes HEAD unreviewed and both gates stale at HEAD", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "src/a.ts", "a\n");
		commitAll(f.work, "c3");
		const c3 = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "src/b.ts", "b\n");
		commitAll(f.work, "d4");
		const out = await ctx(await shipSession(f.work), shipState(f.work, base, { review: c3, ship: c3, pushedHead: c3 }));
		expect(out.reviewed.ok).toBe(false);
		expect(out.gatesAtHead).toEqual({ review: false, ship: false });
	});

	test("a clean integration merge keeps the review gate at HEAD", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "src/a.ts", "a\n");
		commitAll(f.work, "c3");
		const c3 = sh(f.work, "rev-parse", "HEAD");
		await upstreamCommit(f, "src/other.ts");
		sh(f.work, "fetch", "-q", "origin", "main");
		sh(f.work, "merge", "-q", "--no-edit", "--no-ff", "origin/main");
		const out = await ctx(await shipSession(f.work), shipState(f.work, base, { review: c3 }));
		expect(out.reviewed).toEqual({ ok: true });
		expect(out.gatesAtHead).toEqual({ review: true, ship: true });
	});

	test("needsShipGate when the commits after the pushed head change specs/", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "src/a.ts", "a\n");
		commitAll(f.work, "c3");
		const c3 = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "specs/glossary.md", "g\n");
		commitAll(f.work, "e5");
		const e5 = sh(f.work, "rev-parse", "HEAD");
		const out = await ctx(await shipSession(f.work), shipState(f.work, base, { review: e5, pushedHead: c3, marked: [shipRecord(c3, [])] }));
		expect(out.needsShipGate).toBe(true);
	});

	test("needsShipGate when a confirmation item is missing from the latest ship record, false once listed (not memoized)", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "specs/constraints.md", "c\n");
		await writeIn(f.work, "specs/decisions/0001-x.md", "d\n");
		commitAll(f.work, "c3");
		const c3 = sh(f.work, "rev-parse", "HEAD");
		const session = await shipSession(f.work);
		const before = await ctx(session, shipState(f.work, base, { review: c3, pushedHead: c3, marked: [shipRecord(c3, [])] }));
		expect(durableDocsRule(before.facts).confirm).toHaveLength(1);
		expect(before.needsShipGate).toBe(true);
		const listed = shipRecord(c3, durableDocsRule(before.facts).confirm);
		const after = await ctx(session, shipState(f.work, base, { review: c3, pushedHead: c3, marked: [shipRecord(c3, []), listed] }));
		expect(after.needsShipGate).toBe(false);
	});

	test("nothing to re-confirm: needsShipGate is false", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "src/a.ts", "a\n");
		commitAll(f.work, "c3");
		const c3 = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "src/b.ts", "b\n");
		commitAll(f.work, "e5");
		const e5 = sh(f.work, "rev-parse", "HEAD");
		const out = await ctx(await shipSession(f.work), shipState(f.work, base, { review: e5, pushedHead: c3, marked: [shipRecord(c3, [])] }));
		expect(out.needsShipGate).toBe(false);
	});
});

describe("shipContext fails closed per fact", () => {
	test("a review head_sha git does not know is not reviewed and keeps the rest of the context", async () => {
		const f = await fixture();
		const base = sh(f.work, "rev-parse", "HEAD");
		await writeIn(f.work, "src/a.ts", "a\n");
		commitAll(f.work, "c3");
		const out = await ctx(await shipSession(f.work), shipState(f.work, base, { review: "1".repeat(40), ship: "1".repeat(40) }));
		expect(out.reviewed.ok).toBe(false);
		expect(out.gatesAtHead).toEqual({ review: false, ship: false });
		expect(out.facts.files).toEqual(["src/a.ts"]);
	});
});

describe("shipContext behavior records", () => {
	const record = (outcome: string, extra: Partial<DecisionRecord> = {}): MarkedComment => {
		const r: DecisionRecord = { point: "behavior-change", subject: "rate-limit", digest: "d", source: "human", outcome, reason: "chosen by alice", files: ["src/limit/cap.ts"], ...extra };
		const m = parseMarked(decisionComment(r));
		if (m === undefined) throw new Error("not marked");
		return { ...m, commentId: `c-${outcome}${Math.random()}`, author: "bot" } as MarkedComment;
	};

	const CAP = "src/limit/cap.ts";

	/** A rate-limit spec and one changed code file in the ship diff; the spec is in the diff as an `updated` row would be. */
	async function limitDiff(): Promise<Fixture> {
		const f = await fixture();
		await writeIn(f.work, "specs/rate-limit/spec.md", "---\npaths:\n  - src/limit/**\n---\n# rate-limit\n\n## Purpose\nx\n");
		await writeIn(f.work, CAP, "a\n");
		commitAll(f.work, "c3");
		return f;
	}

	const bodyFor = (base: string) => `Base: ${base}\nBranch: feature\nPR: #41\nCapabilities: new [], modified []\n\n## Durable docs\n`;

	test("Agent conclusion covers the files", async () => {
		const f = await limitDiff();
		const base = sh(f.work, "rev-parse", "HEAD~1");
		const marked = [record("unchanged", { source: "agent", reason: "refactor only", files: [CAP] })];
		const body = `${bodyFor(base)}| specs/rate-limit/spec.md | not needed — refactor |\n`;
		const out = await ctx(await shipSession(f.work), shipState(f.work, base, { marked, body }));
		expect(out.facts.behavior).toEqual([{ capability: "rate-limit", files: [CAP], outcome: "unchanged" }]);
		expect(durableDocsRule(out.facts).confirm.filter((c) => c.startsWith("rate-limit:"))).toEqual([]);
		expect(confirmationSection({ ship: { durableFacts: out.facts } } as never) ?? "").not.toMatch(/^- rate-limit:/m);
	});

	test("Newer changed record wins", async () => {
		const f = await limitDiff();
		const base = sh(f.work, "rev-parse", "HEAD~1");
		const marked = [
			record("unchanged", { source: "agent", reason: "refactor only", files: [CAP] }),
			record("changed", { source: "reviewer", reason: "new limit", files: [CAP] }),
		];
		const out = await ctx(await shipSession(f.work), shipState(f.work, base, { marked, body: bodyFor(base) }));
		expect(out.facts.behavior).toEqual([{ capability: "rate-limit", files: [CAP], outcome: "changed" }]);
		expect(durableDocsRule(out.facts).confirm.some((c) => c.startsWith("rate-limit:") && c.includes(CAP))).toBe(true);
	});

	test("Protected change of other files", async () => {
		const f = await limitDiff();
		const base = sh(f.work, "rev-parse", "HEAD~1");
		const marked = [record("changed", { files: ["src/limit/old.ts"] })];
		const out = await ctx(await shipSession(f.work), shipState(f.work, base, { marked, body: bodyFor(base) }));
		expect(out.facts.behavior).toEqual([{ capability: "rate-limit", files: ["src/limit/old.ts"], outcome: "changed" }]);
		expect(durableDocsRule(out.facts).confirm.some((c) => c.startsWith("rate-limit:"))).toBe(true);
	});
});
