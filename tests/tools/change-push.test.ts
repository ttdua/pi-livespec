import { afterEach, describe, expect, test } from "vitest";
import { setSession } from "../../src/hooks/session-store.ts";
import { pollFeedback } from "../../src/ship/feedback-poll.ts";
import { runChangePush, type ShipPoll } from "../../src/tools/change-push.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { asChild } from "../hooks/fake-pi.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, originRefs, textOf, type ToolHarness } from "./helpers.ts";
import { approveShip, branchOf, gateComment, ofKind, shipReady } from "./ship-fixture.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const SKIP: ShipPoll = async () => ({ skipped: true });
const head = (h: ToolHarness): string => h.git("rev-parse", "HEAD");
const remote = (h: ToolHarness): string => h.git("rev-parse", `origin/${branchOf(h)}`);

async function push(h: ToolHarness, poll: ShipPoll = SKIP) {
	const out = await runChangePush({}, { poll });
	return { out, text: out.content.map((c) => c.text).join("\n") };
}

/** A shipped change (PR open, pushed) with the review gate not yet moved. */
async function shipped(): Promise<ToolHarness> {
	const h = await shipReady();
	const out = await h.call("change_ship");
	expect(out.isError, textOf(out)).toBeFalsy();
	return h;
}

/** Commits a fix of `file` and passes the review gate at the new HEAD. */
async function fix(h: ToolHarness, file = "src/limit.ts", gate = true): Promise<string> {
	await writeIn(h.root, file, `fix ${Math.random()}\n`);
	commitAll(h.root, "fix");
	const sha = head(h);
	if (gate) await h.world.postComment(h.n, BOT_LOGIN, gateComment("review", `self-${sha.slice(0, 7)}`, sha));
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
	return sha;
}

/** A reviewed fix that changes `specs/constraints.md` and adds a decision, with its `updated` row. */
async function constraintsFix(h: ToolHarness): Promise<string> {
	await writeIn(h.root, "specs/constraints.md", "# Constraints\n");
	await writeIn(h.root, "specs/decisions/0001-cap.md", "# Cap\n");
	commitAll(h.root, "constraints");
	const sha = head(h);
	const body = (await h.world.bodyOf(h.n)).replace("## Durable docs\n", "## Durable docs\n| File | Status |\n| --- | --- |\n| specs/constraints.md | updated |\n");
	await h.world.editBodyBehindBack(h.n, body);
	await h.world.postComment(h.n, BOT_LOGIN, gateComment("review", `self-${sha.slice(0, 7)}`, sha));
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
	return sha;
}

describe("change_push", () => {
	test("Reviewed fix pushed", async () => {
		const h = await shipped();
		const e5 = await fix(h);
		const { out, text } = await push(h);
		expect(out.isError, text).toBeFalsy();
		expect(originRefs(h.origin)).toContain(`${e5} refs/heads/${branchOf(h)}`);
		const ship = await ofKind(h, "ship");
		expect(ship.map((m) => m.id)).toContain(`ship.${(ship[0]?.data as { pr: number }).pr}.${e5}`);
		expect(remote(h)).toBe(e5);
	});

	test("Unreviewed commits refused", async () => {
		const h = await shipped();
		const before = originRefs(h.origin);
		const e5 = await fix(h, "src/limit.ts", false);
		const { out, text } = await push(h);
		expect(out.isError).toBe(true);
		expect(text).toContain(e5.slice(0, 7));
		expect(originRefs(h.origin)).toBe(before);
	});

	test("Feedback arrived", async () => {
		const h = await shipped();
		await fix(h);
		const before = originRefs(h.origin);
		const { out, text } = await push(h, async () => ({ ingested: 1 }));
		expect(out.isError).toBe(true);
		expect(text).toContain("spec_review");
		expect(originRefs(h.origin)).toBe(before);
	});

	test("poll failure refuses naming the cause", async () => {
		const h = await shipped();
		await fix(h);
		const before = originRefs(h.origin);
		const { out, text } = await push(h, async () => ({ failed: "forge offline" }));
		expect(out.isError).toBe(true);
		expect(text).toContain("forge offline");
		expect(originRefs(h.origin)).toBe(before);
	});

	test("a refused move to review in the poll refuses the push", async () => {
		const h = await shipped();
		await fix(h);
		await h.world.setPermission("alice", "write");
		const pr = h.session.card.kind === "change" ? h.session.card.state.pr?.number : undefined;
		if (pr === undefined) throw new Error("no pull request");
		await h.world.postComment(pr, "alice", "please rename");
		const before = originRefs(h.origin);
		// The real poll; a second phase label appears after the session refreshed, so its move to review is refused.
		const { out, text } = await push(h, async (s) => {
			await h.world.forge.addLabels(h.n, ["livespec:phase/build"]);
			return pollFeedback(s);
		});
		expect(out.isError).toBe(true);
		expect(text).toContain("polling the pull request feedback failed");
		expect(text).toContain("cannot move to review");
		expect(originRefs(h.origin)).toBe(before);
	});

	test("the registered change_push polls pull request feedback by default", async () => {
		const h = await shipped();
		await fix(h);
		await h.world.setPermission("alice", "write");
		const pr = h.session.card.kind === "change" ? h.session.card.state.pr?.number : undefined;
		if (pr === undefined) throw new Error("no pull request");
		await h.world.postComment(pr, "alice", "please rename the cap");
		const before = originRefs(h.origin);
		const out = await h.call("change_push");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("new pull request feedback arrived");
		expect(originRefs(h.origin)).toBe(before);
		const runs = await ofKind(h, "review-run");
		expect(runs.map((m) => (m.data as { source?: string }).source)).toContain("pull-request");
	});

	test("Fix touches constraints", async () => {
		const h = await shipped();
		await constraintsFix(h);
		const before = originRefs(h.origin);
		const { out, text } = await push(h);
		expect(out.isError).toBe(true);
		expect(text).toContain("ship gate");
		expect(originRefs(h.origin)).toBe(before);
		expect(textOf(await h.call("spec_next"))).toContain("Ready for the ship gate");
	});

	test("Fix touching specs pushes once the ship gate is approved at HEAD", async () => {
		const h = await shipped();
		const sha = await constraintsFix(h);
		await approveShip(h, "a9", sha);
		const { out, text } = await push(h);
		expect(out.isError, text).toBeFalsy();
		expect(remote(h)).toBe(sha);
	});

	test("Remote moved", async () => {
		const h = await shipped();
		const pushedHead = remote(h);
		h.git("reset", "-q", "--hard", "HEAD~1");
		await writeIn(h.root, "src/limit.ts", "other history\n");
		commitAll(h.root, "other");
		const sha = head(h);
		await h.world.postComment(h.n, BOT_LOGIN, gateComment("review", "self-x", sha));
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		const before = originRefs(h.origin);
		const { out, text } = await push(h);
		expect(out.isError).toBe(true);
		expect(text).toMatch(/diverge/);
		expect(text).toContain(pushedHead.slice(0, 7));
		expect(originRefs(h.origin)).toBe(before);
	});

	test("no pushed head refuses", async () => {
		const h = await shipReady();
		const pr = await h.world.seedPullRequest({ head: branchOf(h), author: BOT_LOGIN, body: `Refs #${h.n}` });
		await h.world.editBodyBehindBack(h.n, (await h.world.bodyOf(h.n)).replace("Depends: —", `Depends: —\nPR: #${pr}`));
		await h.session.refresh();
		const before = originRefs(h.origin);
		const { out, text } = await push(h);
		expect(out.isError).toBe(true);
		expect(text).toContain("pushed head");
		expect(text).toContain("Branch");
		expect(originRefs(h.origin)).toBe(before);
	});

	test("no PR line refuses", async () => {
		const h = await shipReady();
		const { out } = await push(h);
		expect(out.isError).toBe(true);
	});

	test("dirty tree refuses", async () => {
		const h = await shipped();
		await fix(h);
		await writeIn(h.root, "src/limit.ts", "dirty\n");
		const before = originRefs(h.origin);
		const { out, text } = await push(h);
		expect(out.isError).toBe(true);
		expect(text).toContain("clean");
		expect(originRefs(h.origin)).toBe(before);
	});

	test("wrong branch refuses", async () => {
		const h = await shipped();
		await fix(h);
		h.git("switch", "-q", "-c", "other");
		const before = originRefs(h.origin);
		const { out, text } = await push(h);
		expect(out.isError).toBe(true);
		expect(text).toMatch(/branch/i);
		expect(originRefs(h.origin)).toBe(before);
	});

	test.each([
		["closed", false, "is closed, not open"],
		["merged", true, "the change is in close"],
	])("a %s pull request refuses", async (_name, merged, message) => {
		const h = await shipped();
		await fix(h);
		const [pr] = await h.world.forge.listPullRequests({ state: "open" });
		await h.world.closePullRequestBehindBack(pr?.number ?? 0, merged);
		await h.session.refresh();
		const before = originRefs(h.origin);
		const { out, text } = await push(h);
		expect(out.isError).toBe(true);
		expect(text).toContain(message);
		expect(originRefs(h.origin)).toBe(before);
	});

	test("a durable-docs error refuses", async () => {
		const h = await shipped();
		await fix(h, "specs/constraints.md");
		const before = originRefs(h.origin);
		const { out, text } = await push(h);
		expect(out.isError).toBe(true);
		expect(text).toContain("durable-docs reports");
		expect(text).toContain("decision file");
		expect(originRefs(h.origin)).toBe(before);
	});

	test("a new confirmation item needs the ship gate", async () => {
		const h = await shipReady({ files: { "specs/rate/spec.md": "---\npaths:\n  - src/other.ts\n---\n# rate Specification\n\n## Purpose\nRate.\n" }, body: (b) => b.replace("Files: src/limit.ts", "Files: src/*.ts") });
		const out = await h.call("change_ship");
		expect(out.isError, textOf(out)).toBeFalsy();
		expect((await ofKind(h, "ship"))[0]?.data).toMatchObject({ confirmed: [] });
		await fix(h, "src/other.ts");
		const before = originRefs(h.origin);
		const { out: pushOut, text } = await push(h);
		expect(pushOut.isError).toBe(true);
		expect(text).toContain("ship gate");
		expect(text).toContain("confirmation items");
		expect(originRefs(h.origin)).toBe(before);
	});

	test("HEAD equal to the pushed head has nothing to push", async () => {
		const h = await shipped();
		const before = originRefs(h.origin);
		const { out, text } = await push(h);
		expect(out.isError).toBeFalsy();
		expect(text).toContain("nothing to push");
		expect(originRefs(h.origin)).toBe(before);
		expect(await ofKind(h, "ship")).toHaveLength(1);
	});

	test("push done but its ship record missing: change_push posts the record instead of reporting nothing to push", async () => {
		let failing = true;
		const h = await shipReady({
			forge: (world) =>
				new Proxy(world.forge, {
					get(target, prop, receiver) {
						if (prop === "createComment" && failing) {
							return async (n: number, body: string) => {
								if (body.includes("livespec:ship")) {
									failing = false;
									throw new Error("comment failed");
								}
								return target.createComment(n, body);
							};
						}
						return Reflect.get(target, prop, receiver);
					},
				}),
		});
		expect((await h.call("change_ship")).isError).toBe(true);
		expect(await ofKind(h, "ship")).toEqual([]);
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		const before = originRefs(h.origin);
		const { out, text } = await push(h);
		expect(out.isError, text).toBeFalsy();
		expect(text).toContain("recorded");
		expect(originRefs(h.origin)).toBe(before);
		expect((await ofKind(h, "ship")).map((m) => m.id)).toEqual([expect.stringContaining(head(h))]);
	});

	test("a closing reference in a fix commit message refuses naming the commit", async () => {
		const h = await shipped();
		await writeIn(h.root, "src/limit.ts", "fix closing\n");
		commitAll(h.root, `fix\n\ncloses https://github.com/o/r/issues/${h.n}`);
		const sha = head(h);
		await h.world.postComment(h.n, BOT_LOGIN, gateComment("review", `self-${sha.slice(0, 7)}`, sha));
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		const before = originRefs(h.origin);
		const { out, text } = await push(h);
		expect(out.isError).toBe(true);
		expect(text).toContain(sha.slice(0, 7));
		expect(text).toContain("reword");
		expect(originRefs(h.origin)).toBe(before);
	});

	test("Child pushes", async () => {
		const h = await shipped();
		await fix(h);
		const before = originRefs(h.origin);
		const t = h.pi.tools.get("change_push");
		const out = (await t?.execute("c", {}, undefined, undefined, asChild(h.ctx))) as { isError: boolean; content: { text: string }[] };
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toContain("child session");
		expect(originRefs(h.origin)).toBe(before);
	});
});
