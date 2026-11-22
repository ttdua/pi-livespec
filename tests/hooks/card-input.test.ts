import { afterEach, describe, expect, test } from "vitest";
import { ForgeError } from "../../src/forge/errors.ts";
import { writeMarked } from "../../src/forge/markers.ts";
import "../../src/initiatives/facts.ts";
import "../../src/initiatives/card.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { CHANGE_BRANCH } from "./helpers.ts";
import { cleanupDirs, squashOntoMain, textOf, type ToolHarness, toolHarness } from "../tools/helpers.ts";
import { renderCard } from "../../src/hooks/phase-card.ts";
import { requireChange } from "../../src/tools/guard.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const BODY = "Capabilities: new [], modified []\n\n## Proposal\nP.\n\n## Durable docs\n";

function approvedGate(phase: string, headSha: string): string {
	return writeMarked("gate", `${phase}.r1`, { phase, outcome: "approved", notes: "", by: "alice", at: "2026-11-15T10:00:00.000Z", adapter: "in-session", head_sha: headSha, waivers: [] });
}

/** A change in `phase` with an open pull request and the review gate approved at HEAD, seeded before the first refresh. */
async function changeIn(phase: string): Promise<ToolHarness> {
	const h = await toolHarness({ branch: CHANGE_BRANCH });
	const pr = await h.world.seedPullRequest({ head: CHANGE_BRANCH });
	const body = `Base: ${h.head}\nBranch: ${CHANGE_BRANCH}\nPR: #${pr}\n${BODY}`;
	const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", `livespec:phase/${phase}`] });
	await h.world.postComment(n, BOT_LOGIN, approvedGate("review", h.head));
	await h.session.refresh();
	return h;
}

function cardState(h: ToolHarness) {
	const c = h.session.card;
	if (c.kind !== "change") throw new Error(`no change card: ${c.kind}`);
	return c.state;
}

describe("buildCardInput ship facts", () => {
	test("in ship it fills reviewed, needsShipGate and gatesAtHead", async () => {
		const h = await changeIn("ship");
		expect(cardState(h).ship).toMatchObject({ reviewed: true, needsShipGate: expect.any(Boolean), gatesAtHead: { review: true, ship: true } });
	});

	test("in review it fills gatesAtHead only", async () => {
		const h = await changeIn("review");
		h.git("commit", "-q", "--allow-empty", "-m", "fix");
		await h.session.refresh();
		const ship = cardState(h).ship;
		expect(ship?.gatesAtHead).toEqual({ review: false, ship: true });
		expect(ship).not.toHaveProperty("reviewed");
		expect(ship).not.toHaveProperty("needsShipGate");
	});
});

const SPEC = "# forge-read\n\n## Purpose\nRead.\n\n## Requirements\n\n### Requirement: Read cache\nThe system SHALL cache.\n\n#### Scenario: Fresh\n- **WHEN** a\n- **THEN** b\n";

/** A harness on `fix/typo`; `commit` adds one README commit after `main`. */
async function onFix(o: { commit?: boolean; files?: Record<string, string> } = {}): Promise<ToolHarness> {
	const h = await toolHarness({ branch: "fix/typo", ...(o.files ? { files: o.files } : {}) });
	if (o.commit !== false) {
		await writeIn(h.root, "README.md", "fixed\n");
		commitAll(h.root, "Fix a typo in the README");
	}
	return h;
}

function fixInput(h: ToolHarness) {
	const c = h.session.card;
	if (c.kind !== "fix") throw new Error(`no fix card: ${c.kind}`);
	return c;
}

describe("buildCardInput on a fix branch", () => {
	test("small fix: the lane outcome of the committed diff", async () => {
		const h = await onFix();
		await h.session.refresh();
		expect(fixInput(h)).toMatchObject({ slug: "typo", outcome: { lane: "small", reasons: [] } });
	});

	test("forced fix lists the reason", async () => {
		const h = await onFix({ files: { "specs/forge-read/spec.md": SPEC } });
		await writeIn(h.root, "specs/forge-read/spec.md", `${SPEC}\n### Requirement: Retry budget\nThe system SHALL retry.\n`);
		commitAll(h.root, "Add a retry budget");
		await h.session.refresh();
		const card = fixInput(h);
		expect(card.outcome?.lane).toBe("forced");
		expect(card.outcome?.reasons.join("\n")).toContain("Retry budget");
	});

	test("no commit after the merge base is empty", async () => {
		const h = await onFix({ commit: false });
		await h.session.refresh();
		expect(fixInput(h)).toEqual(expect.objectContaining({ slug: "typo", empty: true }));
		expect(fixInput(h).outcome).toBeUndefined();
	});

	test("Squash-merged fix card", async () => {
		const h = await onFix();
		squashOntoMain(h, "fix/typo");
		await h.session.refresh();
		expect(fixInput(h)).toEqual(expect.objectContaining({ slug: "typo", empty: true }));
		const text = renderCard(fixInput(h));
		expect(text).toContain("Nothing to ship on fix/typo");
		expect(text).not.toContain("fix_ship");
		expect(text).not.toContain("change_new");
	});

	test("facts failure (no origin) becomes an error, never a throw", async () => {
		const h = await onFix();
		h.git("remote", "remove", "origin");
		await h.session.refresh();
		const card = fixInput(h);
		expect(card.error).toMatch(/origin/);
		expect(card.outcome).toBeUndefined();
		expect(renderCard(card)).not.toMatch(/subagent/);
	});

	test("a standalone pack without a lane config shows an error line", async () => {
		const h = await onFix({ files: { ".pi/livespec/flow.yaml": "name: mine\nversion: 1\ncontent: c\nphases:\n  - id: one\n" } });
		await h.session.refresh();
		const card = fixInput(h);
		expect(card.error).toContain("decisions.lane");
		expect(card.outcome).toBeUndefined();
		const text = renderCard(card);
		expect(text).toContain("decisions.lane");
		expect(text).not.toMatch(/Cannot read properties/);
	});

	test("a new origin/<integration> tip at the same HEAD recomputes the card", async () => {
		const h = await onFix();
		await h.session.refresh();
		expect(fixInput(h).outcome?.lane).toBe("small");
		// The fix is merged upstream: origin/main now contains HEAD, and HEAD is unchanged.
		h.git("push", "-q", "origin", "HEAD:refs/heads/main");
		h.git("fetch", "-q", "origin", "main");
		await h.session.refresh();
		expect(fixInput(h)).toEqual(expect.objectContaining({ slug: "typo", empty: true }));
	});

	test("refresh twice fetches once", async () => {
		const h = await onFix();
		await h.session.refresh();
		await h.session.refresh();
		expect(h.gitCalls.filter((a) => a[0] === "fetch")).toHaveLength(1);
		h.git("commit", "-q", "--allow-empty", "-m", "second");
		await h.session.refresh();
		expect(h.gitCalls.filter((a) => a[0] === "fetch")).toHaveLength(2);
	});

	test("a card refresh on a fix branch makes no forge call", async () => {
		const h = await onFix();
		const calls: string[] = [];
		const forge = h.session.forge as unknown as Record<string, unknown>;
		const spied = new Proxy(forge, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					calls.push(String(prop));
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		});
		h.session.forge = spied as never;
		await h.session.refresh();
		expect(fixInput(h).outcome?.lane).toBe("small");
		expect(calls.filter((c) => c !== "isReadOnly")).toEqual([]);
	});

	test("the card records no decision", async () => {
		const h = await onFix();
		await h.session.refresh();
		expect(await h.world.forge.listPullRequests({ state: "open", head: "fix/typo" })).toHaveLength(0);
		expect(h.git("status", "--porcelain")).toBe("");
	});

	test("requireChange refuses with the fix sentence", async () => {
		const h = await onFix();
		await h.session.refresh();
		expect(requireChange(h.session)).toEqual({ ok: false, message: "On fix/typo: run fix_ship or change_new <name> --from-fix; there is no change issue." });
	});
});

describe("readiness refresh facts", () => {
	const CHANGE = "Capabilities: new [], modified [rate-limit]\n\n## Proposal\nP.\n";
	const MERGED_BODY = (pr: number) => `PR: #${pr}\n${CHANGE}`;

	/** Initiative #T with #34 (checked, merged) and the current change #35 depending on it, on #35's branch. */
	async function inInitiative(): Promise<{ h: ToolHarness; t: number; dep: number; n: number }> {
		const h = await toolHarness({ branch: CHANGE_BRANCH });
		const pr = await h.world.seedPullRequest({ head: "livespec/audit-log", state: "closed", merged: true });
		const dep = await h.world.seedIssue({ title: "audit-log", body: MERGED_BODY(pr), labels: ["livespec", "livespec:phase/close"], state: "closed" });
		const t = await h.world.seedIssue({ title: "rate-limit-deps", labels: ["livespec:initiative"], body: "" });
		const n = await h.world.seedIssue({
			title: "per-ip-cap",
			body: `Base: ${h.head}\nBranch: ${CHANGE_BRANCH}\nInitiative: #${t}\nDepends: #${dep}\n${CHANGE}`,
			labels: ["livespec", "livespec:phase/build"],
		});
		await h.world.editBodyBehindBack(t, `Goal: g\nCapabilities: [rate-limit]\n\n## Changes\n- [x] #${dep} audit-log — Depends: —\n- [ ] #${n} per-ip-cap — Depends: #${dep}\n`);
		return { h, t, dep, n };
	}

	test("Progress shown", async () => {
		const { h, t, dep } = await inInitiative();
		await h.session.refresh();
		expect(cardState(h).deps).toMatchObject({ items: [{ number: dep, state: "merged" }], initiative: { number: t, checked: 1, total: 2, ready: [] } });
		const card = renderCard(h.session.card);
		expect(card).toContain(`initiative #${t}: 1 of 2 done`);
		expect(card).toContain(`#${dep} merged`);
	});

	test("pull request reads are memoized until an issue read changes", async () => {
		const { h, dep } = await inInitiative();
		let pulls = 0;
		const inner = h.world.forge as { getPullRequest(n: number): Promise<unknown> };
		const original = inner.getPullRequest.bind(h.world.forge);
		inner.getPullRequest = async (n: number) => {
			pulls += 1;
			return original(n);
		};
		await h.session.refresh();
		const first = pulls;
		expect(first).toBeGreaterThan(0);
		await h.session.refresh();
		expect(pulls).toBe(first);
		await h.world.editBodyBehindBack(dep, `${await h.world.bodyOf(dep)}edited\n`);
		await h.session.refresh();
		expect(pulls).toBeGreaterThan(first);
	});

	test("Two open changes modify the same capability", async () => {
		const { h } = await inInitiative();
		await h.world.seedIssue({ title: "burst", body: `Branch: livespec/burst\n${CHANGE}`, labels: ["livespec", "livespec:phase/build"] });
		await h.world.seedIssue({ title: "later", body: CHANGE, labels: ["livespec", "livespec:phase/define"] });
		await h.session.refresh();
		expect(cardState(h).deps?.overlap.map((o) => o.title)).toEqual(["burst"]);
		expect(renderCard(h.session.card)).toMatch(/#\d+ <untrusted>burst<\/untrusted> also changes <untrusted>rate-limit<\/untrusted>/);
		const status = await h.call("spec_status");
		expect(textOf(status)).toMatch(/#\d+ <untrusted>burst<\/untrusted> also changes <untrusted>rate-limit<\/untrusted>/);
		expect((status.details as { state: { deps?: unknown } }).state.deps).toMatchObject({ overlap: [{ title: "burst" }] });
	});

	test("Too many capabilities suggests an initiative", async () => {
		const h = await toolHarness({ branch: CHANGE_BRANCH });
		await h.world.seedIssue({ title: "per-ip-cap", body: `Branch: ${CHANGE_BRANCH}\nCapabilities: new [], modified [a, b, c, d]\n\n## Proposal\nP.\n`, labels: ["livespec", "livespec:phase/shape"] });
		await h.session.refresh();
		expect(cardState(h).deps?.split).toBe("propose");
		expect(renderCard(h.session.card)).toContain("initiative_propose");
	});

	test("Ready changes proposed", async () => {
		const h = await toolHarness();
		const a = await h.world.seedIssue({ title: "audit-log", body: CHANGE, labels: ["livespec", "livespec:phase/define"] });
		await h.world.seedIssue({ title: "per-ip-cap", body: `Depends: #${a}\n${CHANGE}`, labels: ["livespec", "livespec:phase/define"] });
		await h.world.seedIssue({ title: "burst", body: CHANGE, labels: ["livespec", "livespec:phase/build", "livespec:parked"] });
		await h.session.refresh();
		const card = renderCard(h.session.card);
		expect(card).toContain(`#${a} <untrusted>audit-log</untrusted> (define) ready`);
		expect(card).toContain(`<untrusted>per-ip-cap</untrusted> (define) waits for #${a}`);
		expect(card).toContain("<untrusted>burst</untrusted> (build) parked");
	});

	test("a dependency read failure degrades to no deps fact", async () => {
		const { h, dep } = await inInitiative();
		const inner = h.world.forge as { getIssue(n: number): Promise<unknown> };
		const original = inner.getIssue.bind(h.world.forge);
		inner.getIssue = async (n: number) => {
			if (n === dep) throw new ForgeError({ code: "http", operation: "getIssue", message: "boom", status: 500 });
			return original(n);
		};
		await h.session.refresh();
		expect(h.session.card.kind).toBe("change");
		expect(cardState(h).deps).toBeUndefined();
	});
});
