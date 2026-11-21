import { afterEach, describe, expect, test } from "vitest";
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

type Setup = { forge?: (world: MemoryWorld) => Forge; initiative?: boolean; others?: string[]; pr?: "open" | "merged" | "closed"; phase?: string };

async function closeReady(o: Setup = {}): Promise<ToolHarness & { tracking?: number }> {
	const h = await shipReady({ config: FORGE_CHAIN, noShipGate: true, ...(o.forge ? { forge: o.forge } : {}) });
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

	test("a child session refuses", async () => {
		const h = await closeReady();
		const t = h.pi.tools.get("change_close");
		const out = (await t?.execute("c", {}, undefined, undefined, asChild(h.ctx))) as { isError: boolean; content: { text: string }[] };
		expect(out.isError).toBe(true);
		expect(await issueState(h, h.n)).toBe("open");
		expect(emits(h)).toEqual([]);
	});
});
