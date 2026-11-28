import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { originRefs } from "./helpers.ts";
import { writeMarked } from "../../src/forge/markers.ts";
import { parseInitiative } from "../../src/core/initiative.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { asChild } from "../hooks/fake-pi.ts";
import type { MemoryWorld } from "../forge/memory-forge.ts";
import type { Forge } from "../../src/forge/types.ts";
import { BOT_LOGIN, OTHER_LOGIN } from "../forge/world.ts";
import { cleanupDirs, textOf, type ToolHarness } from "./helpers.ts";
import { FORGE_CHAIN, marked, ofKind, shipReady } from "./ship-fixture.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const initiativeBody = (n: number, others: string[] = []) =>
	["Goal: cap", "Capabilities: [rate-limit]", "", "## Changes", `- [ ] #${n} per-ip-cap — Depends: —`, ...others, ""].join("\n");

type Setup = { forge?: (world: MemoryWorld) => Forge; initiative?: boolean; others?: string[]; pr?: "open" | "merged" | "closed"; phase?: string; retain?: boolean };

async function closeReady(o: Setup = {}): Promise<ToolHarness & { tracking?: number }> {
	const ledger = o.retain === undefined ? "" : `ledger: { retain: ${o.retain} }\n`;
	const h = await shipReady({ config: `${FORGE_CHAIN}${ledger}`, noShipGate: true, ...(o.forge ? { forge: o.forge } : {}) });
	let tracking: number | undefined;
	if (o.initiative) {
		tracking = await h.world.seedIssue({ title: "initiative", body: initiativeBody(h.n, o.others), labels: [] });
		await h.world.editBodyBehindBack(h.n, `Initiative: #${tracking}\n${await h.world.bodyOf(h.n)}`);
	}
	const pr = await h.world.seedPullRequest({ head: "livespec/per-ip-cap", ...(o.pr === "merged" || o.pr === undefined ? { state: "closed" as const, merged: true } : o.pr === "closed" ? { state: "closed" as const } : {}) });
	await h.world.editBodyBehindBack(h.n, (await h.world.bodyOf(h.n)).replace(/^Branch:/m, `PR: #${pr}\nBranch:`));
	await h.world.dropLabel("livespec:phase/ship");
	await h.world.forge.addLabels?.(h.n, [`livespec:phase/${o.phase ?? "close"}`]);
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
	return tracking === undefined ? h : { ...h, tracking };
}

const emits = (h: ToolHarness) => (h.pi.api.events.emit as unknown as { mock: { calls: unknown[][] } }).mock.calls;
const issueState = async (h: ToolHarness, n: number) => (await h.world.forge.getIssue(n)).state;

describe("change_close", () => {
	test("Close after merge", async () => {
		const h = await closeReady();
		const out = await h.call("change_close", {});
		expect(out.isError, textOf(out)).toBeFalsy();
		const summary = await ofKind(h, "close-summary");
		expect(summary.map((m) => m.id)).toEqual([`close-summary.${h.n}`]);
		expect(summary[0]?.data).toMatchObject({ units: ["U1 done"], reviewRounds: 0 });
		expect(await issueState(h, h.n)).toBe("closed");
		expect(emits(h)).toEqual([["livespec:change-closed", { change: h.n, pr: expect.any(Number) }]]);
	});

	test("Not merged", async () => {
		const h = await closeReady({ pr: "open" });
		const out = await h.call("change_close", {});
		expect(out.isError).toBe(true);
		expect(await issueState(h, h.n)).toBe("open");
		expect(await ofKind(h, "close-summary")).toEqual([]);
		expect(emits(h)).toEqual([]);
	});

	test("Last change of an initiative", async () => {
		const h = await closeReady({ initiative: true });
		const out = await h.call("change_close", {});
		expect(out.isError, textOf(out)).toBeFalsy();
		const t = h.tracking as number;
		expect(parseInitiative(await h.world.bodyOf(t)).changes[0]?.checked).toBe(true);
		expect(await issueState(h, t)).toBe("closed");
		const ids = (await h.world.forge.listComments(t)).map((c) => c.body).join("\n");
		expect(ids).toContain("close-summary.initiative");
		expect(emits(h).map((c) => c[0])).toEqual(["livespec:change-closed", "livespec:initiative-closed"]);
		expect(emits(h)[0]?.[1]).toMatchObject({ initiative: t });
		expect(emits(h)[1]?.[1]).toEqual({ initiative: t, changes: [h.n] });
	});

	test("an initiative with another open entry stays open", async () => {
		const h = await closeReady({ initiative: true, others: ["- [ ] #99 other — Depends: —"] });
		await h.call("change_close", {});
		const t = h.tracking as number;
		expect(await issueState(h, t)).toBe("open");
		expect(emits(h).map((c) => c[0])).toEqual(["livespec:change-closed"]);
	});

	test("Retry after a partial close", async () => {
		let failures = 1;
		const flaky = (world: MemoryWorld): Forge => {
			const f = world.forge;
			return new Proxy(f, {
				get: (t, k) => {
					if (k === "closeIssue") {
						return async (n: number) => {
							if (n === (flakyTarget as { n: number }).n && failures-- > 0) throw new Error("boom");
							return t.closeIssue(n);
						};
					}
					const v = Reflect.get(t, k) as unknown;
					return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
				},
			});
		};
		const flakyTarget = { n: -1 };
		const h = await closeReady({ initiative: true, others: ["- [ ] #99 other — Depends: —"], forge: flaky });
		flakyTarget.n = h.n;
		const first = await h.call("change_close", {});
		expect(first.isError).toBe(true);
		expect(await issueState(h, h.n)).toBe("open");
		expect(emits(h)).toEqual([]);
		const t = h.tracking as number;
		expect(parseInitiative(await h.world.bodyOf(t)).changes[0]?.checked).toBe(true);
		const bodyAfterFirst = await h.world.bodyOf(t);
		const second = await h.call("change_close", {});
		expect(second.isError, textOf(second)).toBeFalsy();
		expect((await ofKind(h, "close-summary")).map((m) => m.id)).toEqual([`close-summary.${h.n}`]);
		expect(await h.world.bodyOf(t)).toBe(bodyAfterFirst);
		expect(await issueState(h, h.n)).toBe("closed");
		expect(emits(h).map((c) => c[0])).toEqual(["livespec:change-closed"]);
	});

	test("a closeIssue that stores the close but throws still emits the close events", async () => {
		const target = { n: -1 };
		const timeout = (world: MemoryWorld): Forge =>
			new Proxy(world.forge, {
				get: (t, k) => {
					if (k === "closeIssue") {
						return async (n: number) => {
							await t.closeIssue(n);
							if (n === target.n) throw new Error("timeout");
						};
					}
					const v = Reflect.get(t, k) as unknown;
					return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
				},
			});
		const h = await closeReady({ forge: timeout });
		target.n = h.n;
		const out = await h.call("change_close", {});
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(await issueState(h, h.n)).toBe("closed");
		expect(emits(h).map((c) => c[0])).toEqual(["livespec:change-closed"]);
	});

	test("a closeIssue that throws and leaves the issue open still fails", async () => {
		const target = { n: -1 };
		const broken = (world: MemoryWorld): Forge =>
			new Proxy(world.forge, {
				get: (t, k) => {
					if (k === "closeIssue") {
						return async (n: number) => {
							if (n === target.n) throw new Error("boom");
							return t.closeIssue(n);
						};
					}
					const v = Reflect.get(t, k) as unknown;
					return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
				},
			});
		const h = await closeReady({ forge: broken });
		target.n = h.n;
		const out = await h.call("change_close", {});
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("boom");
		expect(emits(h)).toEqual([]);
	});

	test("a foreign close-summary.initiative does not count; the own one is posted", async () => {
		const h = await closeReady({ initiative: true });
		const t = h.tracking as number;
		await h.world.postComment(t, OTHER_LOGIN, writeMarked("close-summary", "close-summary.initiative", { pr: 1, units: [], durableDocs: [], reviewRounds: 0 }));
		const out = await h.call("change_close", {});
		expect(out.isError, textOf(out)).toBeFalsy();
		const own = (await h.world.forge.listComments(t)).filter((c) => c.author === BOT_LOGIN && c.body.includes("close-summary.initiative"));
		expect(own).toHaveLength(1);
		expect(emits(h).map((c) => c[0])).toEqual(["livespec:change-closed", "livespec:initiative-closed"]);
	});

	test("an initiative that does not list the change refuses with both numbers", async () => {
		const h = await closeReady({ initiative: true });
		const t = h.tracking as number;
		await h.world.editBodyBehindBack(t, (await h.world.bodyOf(t)).replace(`#${h.n} per`, "#98 per"));
		const out = await h.call("change_close", {});
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("refused");
		expect(textOf(out)).toContain("Nothing was written");
		expect(await ofKind(h, "close-summary")).toEqual([]);
		expect(textOf(out)).toContain(`initiative #${t}`);
		expect(textOf(out)).toContain(`#${h.n}`);
		expect(await issueState(h, h.n)).toBe("open");
		expect(emits(h)).toEqual([]);
	});

	test("a throwing event listener still reports success and the close", async () => {
		const h = await closeReady();
		(h.pi.api.events.emit as unknown as { mockImplementationOnce: (f: () => void) => void }).mockImplementationOnce(() => {
			throw new Error("listener broke");
		});
		const out = await h.call("change_close", {});
		expect(out.isError).toBeFalsy();
		expect(textOf(out)).toContain("listener broke");
		expect(await issueState(h, h.n)).toBe("closed");
	});

	test("a refresh failure after the close still emitted the events", async () => {
		const h = await closeReady();
		const real = h.session.refresh.bind(h.session);
		h.session.refresh = async () => {
			if ((await h.world.forge.getIssue(h.n)).state === "closed") throw new Error("refresh broke");
			return real();
		};
		const out = await h.call("change_close", {});
		expect(out.isError).toBeFalsy();
		expect(textOf(out)).toContain("refresh broke");
		expect(await issueState(h, h.n)).toBe("closed");
		expect(emits(h).map((c) => c[0])).toEqual(["livespec:change-closed"]);
	});

	test("Retry after the initiative closed", async () => {
		const h = await closeReady({ initiative: true });
		const t = h.tracking as number;
		await h.world.editBodyBehindBack(t, (await h.world.bodyOf(t)).replace(`- [ ] #${h.n}`, `- [x] #${h.n}`));
		await h.world.postComment(t, BOT_LOGIN, (await import("../../src/forge/markers.ts")).writeMarked("close-summary", "close-summary.initiative", { pr: 1, units: [], durableDocs: [], reviewRounds: 0 }));
		await h.world.forge.closeIssue(t);
		const out = await h.call("change_close", {});
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(await issueState(h, h.n)).toBe("closed");
		expect(emits(h).map((c) => c[0])).toEqual(["livespec:change-closed", "livespec:initiative-closed"]);
		expect((await h.world.forge.listComments(t)).filter((c) => c.body.includes("close-summary.initiative"))).toHaveLength(1);
	});

	test("Abandon", async () => {
		const h = await closeReady({ initiative: true, pr: "closed", phase: "ship" });
		const out = await h.call("change_close", { abandon: "superseded by #50" });
		expect(out.isError, textOf(out)).toBeFalsy();
		const summary = await ofKind(h, "close-summary");
		expect(summary[0]?.data).toMatchObject({ abandoned: "superseded by #50" });
		expect(parseInitiative(await h.world.bodyOf(h.tracking as number)).changes[0]?.checked).toBe(false);
		expect(await issueState(h, h.n)).toBe("closed");
		expect(emits(h)).toEqual([["livespec:change-closed", { change: h.n, pr: expect.any(Number), initiative: h.tracking, abandoned: true }]]);
	});

	test("an empty abandon reason refuses", async () => {
		const h = await closeReady({ pr: "closed", phase: "ship" });
		const out = await h.call("change_close", { abandon: "  " });
		expect(out.isError).toBe(true);
		expect(await issueState(h, h.n)).toBe("open");
		expect((await marked(h)).some((m) => m.kind === "close-summary")).toBe(false);
	});

	test("abandon with an open pull request refuses", async () => {
		const h = await closeReady({ pr: "open", phase: "ship" });
		const out = await h.call("change_close", { abandon: "no" });
		expect(out.isError).toBe(true);
		expect(await issueState(h, h.n)).toBe("open");
	});

	/** A started change in build with no `PR` line; with `choice`, an approved `new-dependency` result choosing it. */
	async function noPr(choice?: { id: string; action: string }): Promise<ToolHarness> {
		const h = await shipReady({ config: FORGE_CHAIN, noShipGate: true });
		await h.world.dropLabel("livespec:phase/ship");
		await h.world.forge.addLabels?.(h.n, ["livespec:phase/build"]);
		if (choice) {
			const drafts = { unit: "U1", evidence: "e", a: { name: "token-store", proposal: "p", depends: [] }, b: { units: ["U4"], summary: "s" }, c: { summary: "s", follow_up: { name: "f", proposal: "p" } }, d: { action: choice.action, reason: "wrong direction" } };
			await h.world.postComment(h.n, BOT_LOGIN, writeMarked("request", "gate-new-dependency.r1", { subject: "gate:new-dependency", kind: "gate", mode: "blocking", snapshot: { target: "new-dependency", failingWaivable: [], drafts } }));
			await h.world.postComment(h.n, BOT_LOGIN, writeMarked("gate", "new-dependency.gate-new-dependency.r1", { request: "gate-new-dependency.r1", gate: "new-dependency", outcome: "approved", choice: choice.id, notes: "", by: "alice", at: "t", adapter: "forge", head_sha: "h", waivers: [] }));
		}
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		return h;
	}

	test("Drop after a discovered dependency", async () => {
		const h = await noPr({ id: "D", action: "drop" });
		const out = await h.call("change_close", { abandon: "wrong direction" });
		expect(out.isError, textOf(out)).toBeFalsy();
		const summary = (await ofKind(h, "close-summary"))[0]?.data as Record<string, unknown>;
		expect(summary).toMatchObject({ abandoned: "wrong direction" });
		expect(summary).not.toHaveProperty("pr");
		expect(await issueState(h, h.n)).toBe("closed");
		expect(emits(h)).toEqual([["livespec:change-closed", { change: h.n, abandoned: true }]]);
	});

	test("Abandon refused without a pull request or drop", async () => {
		for (const choice of [undefined, { id: "D", action: "shape" }, { id: "A", action: "drop" }]) {
			const h = await noPr(choice);
			const out = await h.call("change_close", { abandon: "x" });
			expect(out.isError).toBe(true);
			expect(await issueState(h, h.n)).toBe("open");
			expect(await ofKind(h, "close-summary")).toEqual([]);
			expect(emits(h)).toEqual([]);
		}
	});

	test("without abandon a change with no PR line still refuses after D drop", async () => {
		const h = await noPr({ id: "D", action: "drop" });
		const out = await h.call("change_close", {});
		expect(out.isError).toBe(true);
		expect(await issueState(h, h.n)).toBe("open");
	});

	test("a child session refuses", async () => {
		const h = await closeReady();
		const t = h.pi.tools.get("change_close");
		const out = (await t?.execute("c", {}, undefined, undefined, asChild(h.ctx))) as { isError: boolean; content: { text: string }[] };
		expect(out.isError).toBe(true);
		expect(await issueState(h, h.n)).toBe("open");
		expect(emits(h)).toEqual([]);
	});
});

describe("change_close ledger retention", () => {
	/** Appends one ledger entry, so the change has a local ledger ref and origin has a copy of it. */
	async function withLedger(h: ToolHarness): Promise<void> {
		await h.session.ledger.append(h.n, { kind: "decision", id: "D1", data: { answer: "x" } });
		await h.settle();
		expect(await h.session.ledger.sync(h.n)).toEqual({ status: "synced" });
	}

	const localRef = (h: ToolHarness) => h.git("for-each-ref", "--format=%(refname)", `refs/livespec/${h.n}`);
	const originHasLedger = (h: ToolHarness) => originRefs(h.origin).includes(`refs/livespec/${h.n}`);

	test("Default keeps the ledger", async () => {
		const h = await closeReady();
		await withLedger(h);
		const out = await h.call("change_close", {});
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(localRef(h)).toBe(`refs/livespec/${h.n}`);
		expect(originHasLedger(h)).toBe(true);
	});

	test("Retain false deletes it", async () => {
		const h = await closeReady({ retain: false });
		await withLedger(h);
		const out = await h.call("change_close", {});
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(await issueState(h, h.n)).toBe("closed");
		expect(localRef(h)).toBe("");
		expect(originHasLedger(h)).toBe(false);
		expect(textOf(out)).not.toContain("could not");
	});

	test("Remote delete fails", async () => {
		const h = await closeReady({ retain: false });
		await withLedger(h);
		// A pre-receive hook rejects the ledger delete, so the remote delete fails.
		writeFileSync(join(h.origin, "hooks", "pre-receive"), "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/livespec/*) echo rejected >&2; exit 1;; esac; done\n", { mode: 0o755 });
		const out = await h.call("change_close", {});
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(await issueState(h, h.n)).toBe("closed");
		expect(localRef(h)).toBe("");
		expect(originHasLedger(h)).toBe(true);
		expect(textOf(out)).toContain(`the ledger of #${h.n} was not deleted from origin`);
		expect(emits(h).map((c) => c[0])).toEqual(["livespec:change-closed"]);
	});

	test("retry with no local ref skips the step", async () => {
		const h = await closeReady({ retain: false });
		// A retry after an earlier close: the local ledger ref is already gone, so the step has nothing to delete.
		expect(localRef(h)).toBe("");
		const out = await h.call("change_close", {});
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(textOf(out)).not.toContain("was not deleted");
		expect(textOf(out)).not.toContain("the ledger");
	});
});
