import { BRIEFING } from "../helpers/briefing.ts";
import { afterEach, describe, expect, test } from "vitest";
import { pickByLabel } from "../helpers/menu.ts";
import { parseChange } from "../../src/core/change.ts";
import { gateDigest } from "../../src/engine/locks.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import type { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN, OTHER_LOGIN } from "../forge/world.ts";
import { asChild, type FakeUI } from "../hooks/fake-pi.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, originRefs, textOf, type ToolHarness, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

import { AT, FORGE_CHAIN, approveShip, branchOf, gateComment, marked, ofKind, openPulls, pushed, shipReady, type Opts } from "./ship-fixture.ts";

async function expectNothingShipped(h: ToolHarness, before: string): Promise<void> {
	expect(originRefs(h.origin)).toBe(before);
	expect(await openPulls(h)).toEqual([]);
	expect(parseChange(await h.world.bodyOf(h.n)).header.pr).toBeUndefined();
}

describe("change_ship", () => {
	test("One pull request", async () => {
		const h = await shipReady();
		const head = h.git("rev-parse", "HEAD");
		const out = await h.call("change_ship");
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(originRefs(h.origin)).toContain(`${head} refs/heads/livespec/per-ip-cap`);
		const pulls = await openPulls(h);
		expect(pulls).toHaveLength(1);
		const pr = pulls[0]!;
		expect(pr).toMatchObject({ head: "livespec/per-ip-cap", base: "main", title: "per-ip-cap" });
		expect(pr.body).toContain(`Refs #${h.n}`);
		expect(pr.body).toContain("Refs #12");
		expect(pr.body).not.toMatch(/closes/i);
		expect(parseChange(await h.world.bodyOf(h.n)).header.pr).toBe(`#${pr.number}`);
		const ship = await ofKind(h, "ship");
		expect(ship.map((m) => m.id)).toEqual([`ship.${pr.number}.${head}`]);
		expect(ship[0]?.data).toEqual({ pr: pr.number, pushedHead: head, confirmed: [] });
		expect(textOf(out)).toContain(`#${pr.number}`);
	});

	test("Refspec from the issue", async () => {
		const h = await shipReady({ branch: "livespec/rate-limit" });
		const out = await h.call("change_ship");
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(h.gitCalls).toContainEqual(["push", "--", "origin", "HEAD:refs/heads/livespec/rate-limit"]);
	});

	test("Commit after the reviewed SHA (the ship gate names both SHAs)", async () => {
		const h = await shipReady({ noShipGate: true });
		const c3 = h.git("rev-parse", "HEAD");
		await approveShip(h, "a1", c3);
		await writeIn(h.root, "src/limit.ts", "export const cap = 101;\n");
		commitAll(h.root, "d4");
		const d4 = h.git("rev-parse", "HEAD");
		// The review gate passed at d4, so the change stays in ship; the ship gate is still at c3.
		await h.world.postComment(h.n, BOT_LOGIN, gateComment("review", "self-2", d4));
		await h.session.comments?.invalidate(h.n);
		const before = originRefs(h.origin);
		const out = await h.call("change_ship");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(d4.slice(0, 7));
		expect(textOf(out)).toContain(c3.slice(0, 7));
		await expectNothingShipped(h, before);
	});

	test("Commit after the reviewed SHA (review and ship gates at c3) pushes nothing", async () => {
		const h = await shipReady();
		await writeIn(h.root, "src/limit.ts", "export const cap = 101;\n");
		commitAll(h.root, "d4");
		const before = originRefs(h.origin);
		const out = await h.call("change_ship");
		expect(out.isError).toBe(true);
		await expectNothingShipped(h, before);
	});

	test("File outside every unit", async () => {
		const h = await shipReady({ noShipGate: true });
		await writeIn(h.root, "src/extra.ts", "x\n");
		commitAll(h.root, "extra");
		const head = h.git("rev-parse", "HEAD");
		await h.world.postComment(h.n, BOT_LOGIN, gateComment("review", "self-2", head));
		await approveShip(h, "a1", head);
		const before = originRefs(h.origin);
		const out = await h.call("change_ship");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("src/extra.ts");
		await expectNothingShipped(h, before);
	});

	test("Another pull request open", async () => {
		const h = await shipReady();
		const other = await h.world.seedPullRequest({ head: "livespec/per-ip-cap", author: OTHER_LOGIN, body: `Refs #${h.n}` });
		const before = originRefs(h.origin);
		const out = await h.call("change_ship");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(`#${other}`);
		expect(originRefs(h.origin)).toBe(before);
		expect(await openPulls(h)).toHaveLength(1);
		expect(parseChange(await h.world.bodyOf(h.n)).header.pr).toBeUndefined();
	});

	test("Retry after a partial ship", async () => {
		let failing = true;
		const h = await shipReady({
			forge: (world) =>
				new Proxy(world.forge, {
					get(target, prop, receiver) {
						if (prop === "updateIssueBody" && failing) {
							return async () => {
								failing = false;
								throw new Error("body write failed");
							};
						}
						return Reflect.get(target, prop, receiver);
					},
				}),
		});
		const first = await h.call("change_ship");
		expect(first.isError).toBe(true);
		const pulls = await openPulls(h);
		expect(pulls).toHaveLength(1);
		expect(parseChange(await h.world.bodyOf(h.n)).header.pr).toBeUndefined();
		const second = await h.call("change_ship");
		expect(second.isError, textOf(second)).toBeFalsy();
		expect(await openPulls(h)).toHaveLength(1);
		expect(parseChange(await h.world.bodyOf(h.n)).header.pr).toBe(`#${pulls[0]?.number}`);
		expect(await ofKind(h, "ship")).toHaveLength(1);
	});

	test("Human comment after the ship gate", async () => {
		const h = await shipReady();
		await h.world.setPermission("alice", "write");
		const id = await h.world.postComment(h.n, "alice", "wait, one more thing");
		await h.session.comments?.invalidate(h.n);
		const before = originRefs(h.origin);
		const out = await h.call("change_ship");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("stale");
		await expectNothingShipped(h, before);
		const stale = await ofKind(h, "stale");
		expect(stale).toHaveLength(1);
		expect(stale[0]?.id.startsWith(`stale.ship.`)).toBe(true);
		expect(stale[0]?.id.includes(`.${id}-`)).toBe(true);
		expect(stale[0]?.data).toMatchObject({ phases: ["ship"] });
		expect(textOf(await h.call("spec_next"))).toContain("Ready for the ship gate");
	});

	test("a comment of an author with read access only does not make the ship stale", async () => {
		const h = await shipReady();
		await h.world.setPermission("alice", "read");
		await h.world.postComment(h.n, "alice", "looks fine to me");
		await h.session.comments?.invalidate(h.n);
		const out = await h.call("change_ship");
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(await ofKind(h, "stale")).toEqual([]);
	});

	test("a failed permission read refuses and ships nothing", async () => {
		const h = await shipReady({
			forge: (world) =>
				new Proxy(world.forge, {
					get(target, prop, receiver) {
						if (prop === "getPermission") return async () => { throw new Error("permission API down"); };
						return Reflect.get(target, prop, receiver);
					},
				}),
		});
		await h.world.postComment(h.n, "alice", "wait");
		await h.session.comments?.invalidate(h.n);
		const before = originRefs(h.origin);
		const out = await h.call("change_ship");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("permission");
		await expectNothingShipped(h, before);
	});

	test("stale, ship gate approved again, a new human comment: stale again with a new id", async () => {
		const h = await shipReady();
		await h.world.setPermission("alice", "write");
		const first = await h.world.postComment(h.n, "alice", "one");
		await h.session.comments?.invalidate(h.n);
		await h.call("change_ship");
		await approveShip(h, "a2");
		const second = await h.world.postComment(h.n, "alice", "two");
		await h.session.comments?.invalidate(h.n);
		const out = await h.call("change_ship");
		expect(out.isError).toBe(true);
		const ids = (await ofKind(h, "stale")).map((m) => m.id);
		expect(ids).toHaveLength(2);
		expect(ids[0]?.includes(`.${first}-`)).toBe(true);
		expect(ids[1]?.includes(`.${second}-`)).toBe(true);
		expect(await openPulls(h)).toEqual([]);
	});

	test("a body edit after a new approval is stale again although the digest repeats", async () => {
		const h = await shipReady();
		const d1 = await h.world.bodyOf(h.n);
		const d2 = d1.replace("Counter.", "Sliding counter.");
		await h.world.editBodyBehindBack(h.n, d2);
		await h.call("change_ship");
		await h.world.editBodyBehindBack(h.n, d1);
		await approveShip(h, "a2");
		await h.world.editBodyBehindBack(h.n, d2);
		const out = await h.call("change_ship");
		expect(out.isError).toBe(true);
		expect(await ofKind(h, "stale")).toHaveLength(2);
		expect(textOf(await h.call("spec_next"))).toContain("Ready for the ship gate");
	});

	test("the gate digest changed: stale refusal", async () => {
		const h = await shipReady();
		const body = (await h.world.bodyOf(h.n)).replace("Counter.", "Sliding counter.");
		await h.world.editBodyBehindBack(h.n, body);
		const before = originRefs(h.origin);
		const out = await h.call("change_ship");
		expect(out.isError).toBe(true);
		await expectNothingShipped(h, before);
		expect((await ofKind(h, "stale")).map((m) => m.id)).toEqual([expect.stringMatching(new RegExp(`^stale\\.ship\\.[^.]+\\.digest\\.${gateDigest(body)}$`))]);
	});

	test("Forge approval then ship", async () => {
		const h = await shipReady({ noShipGate: true, config: FORGE_CHAIN });
		const asked = await h.call("spec_gate", { target: "ship", briefing: BRIEFING });
		expect(asked.isError, textOf(asked)).toBeFalsy();
		await h.world.setPermission("alice", "write");
		await h.world.postComment(h.n, "alice", "/livespec approve");
		await h.session.comments?.invalidate(h.n);
		const out = await h.call("change_ship");
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(await openPulls(h)).toHaveLength(1);
	});

	test("in-session approval then ship", async () => {
		const ui: FakeUI = { hasUI: true, select: async (title, options) => (title === "Add notes?" ? "No notes" : pickByLabel(options, "approve")) };
		const h = await shipReady({ noShipGate: true, ui });
		const asked = await h.call("spec_gate", { target: "ship", briefing: BRIEFING });
		expect(asked.isError, textOf(asked)).toBeFalsy();
		const out = await h.call("change_ship");
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(await openPulls(h)).toHaveLength(1);
	});

	test("Clean merge after the ship gate", async () => {
		const h = await shipReady();
		const branch = branchOf(h);
		h.git("switch", "-q", "main");
		await writeIn(h.root, "src/other.ts", "o\n");
		commitAll(h.root, "other change");
		h.git("push", "-q", "origin", "main");
		h.git("switch", "-q", branch);
		h.git("merge", "-q", "--no-edit", "main");
		const out = await h.call("change_ship");
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(await openPulls(h)).toHaveLength(1);
	});

	test("Ship gate not approved", async () => {
		const h = await shipReady({ noShipGate: true });
		const before = originRefs(h.origin);
		const out = await h.call("change_ship");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("ship gate");
		await expectNothingShipped(h, before);
		expect(await ofKind(h, "stale")).toEqual([]);
	});

	test("Child ships", async () => {
		const h = await shipReady();
		const before = originRefs(h.origin);
		const t = h.pi.tools.get("change_ship");
		const out = (await t?.execute("c", {}, undefined, undefined, asChild(h.ctx))) as { isError: boolean; content: { text: string }[] };
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toContain("child session");
		await expectNothingShipped(h, before);
	});

	test("a change without its Branch line refuses naming the Branch line", async () => {
		const h = await shipReady();
		const body = (await h.world.bodyOf(h.n)).replace(/^Branch: .*\n/m, "");
		await h.world.editBodyBehindBack(h.n, body);
		const before = originRefs(h.origin);
		const out = await h.call("change_ship");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("Branch");
		expect(originRefs(h.origin)).toBe(before);
		expect(await openPulls(h)).toEqual([]);
	});

	test("a dirty tree refuses", async () => {
		const h = await shipReady();
		await writeIn(h.root, "src/limit.ts", "dirty\n");
		const before = originRefs(h.origin);
		const out = await h.call("change_ship");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("clean");
		await expectNothingShipped(h, before);
	});

	test("a closing reference in a commit message refuses naming the commit", async () => {
		const h = await shipReady({ noShipGate: true });
		await writeIn(h.root, "src/limit.ts", "export const cap = 50;\n");
		commitAll(h.root, `lower cap\n\nFixes #${h.n}`);
		const head = h.git("rev-parse", "HEAD");
		await h.world.postComment(h.n, BOT_LOGIN, gateComment("review", "self-2", head));
		await approveShip(h, "a1", head);
		const before = originRefs(h.origin);
		const out = await h.call("change_ship");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(head.slice(0, 7));
		expect(textOf(out)).toContain(`Fixes #${h.n}`);
		expect(textOf(out)).toContain("reword");
		await expectNothingShipped(h, before);
	});

	test("a PR line refuses naming change_push", async () => {
		const h = await shipReady({ body: (b) => b.replace("Depends: —", "Depends: —\nPR: #99") });
		const before = originRefs(h.origin);
		const out = await h.call("change_ship");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("change_push");
		expect(originRefs(h.origin)).toBe(before);
		expect(await openPulls(h)).toEqual([]);
	});

	test("two concurrent calls open one pull request", async () => {
		const h = await shipReady();
		const outs = await Promise.all([h.call("change_ship"), h.call("change_ship")]);
		expect(outs.filter((o) => !o.isError)).toHaveLength(1);
		expect(await openPulls(h)).toHaveLength(1);
		expect(await ofKind(h, "ship")).toHaveLength(1);
		expect(pushed(h)).toBe(true);
	});
});
