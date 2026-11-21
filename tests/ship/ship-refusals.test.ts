import { describe, expect, test } from "vitest";
import type { PullRequest } from "../../src/forge/types.ts";
import { pullRequestChoice, shipLocalRefusal, staleShipId } from "../../src/ship/ship-refusals.ts";
import { stateFor } from "../helpers/change-state.ts";

const pull = (number: number, author: string, body: string): PullRequest => ({ number, state: "open", merged: false, head: "livespec/x", base: "main", title: "t", body, author, version: "v" as PullRequest["version"] });

describe("pullRequestChoice", () => {
	test("no open pull request opens one", () => {
		expect(pullRequestChoice([], { login: "me", change: 7 })).toEqual({ kind: "open" });
	});
	test("an own pull request with Refs is adopted", () => {
		expect(pullRequestChoice([pull(41, "me", "x\n\nRefs #7")], { login: "me", change: 7 })).toMatchObject({ kind: "adopt", pr: { number: 41 } });
	});
	test("an own pull request without Refs #<change> refuses", () => {
		expect(pullRequestChoice([pull(41, "me", "Refs #70")], { login: "me", change: 7 })).toMatchObject({ kind: "refused" });
	});
	test("someone else's pull request refuses naming it", () => {
		const out = pullRequestChoice([pull(41, "me", "Refs #7"), pull(42, "eve", "Refs #7")], { login: "me", change: 7 });
		expect(out).toMatchObject({ kind: "refused" });
		expect(out.kind === "refused" && out.reason).toContain("#42");
	});
});

describe("shipLocalRefusal", () => {
	const noPr = (b: string) => b.replace(/^PR: .*\n/m, "");
	test("all hold", () => {
		const state = stateFor("ship", {}, noPr(stateFor("ship").change.lines.map((l) => l.text).join("\n")));
		expect(shipLocalRefusal(state)).toBeUndefined();
	});
	test("wrong phase, PR line, dirty tree, wrong branch", () => {
		const body = noPr(stateFor("ship").change.lines.map((l) => l.text).join("\n"));
		expect(shipLocalRefusal(stateFor("review", {}, body))).toContain("review");
		expect(shipLocalRefusal(stateFor("ship"))).toContain("change_push");
		expect(shipLocalRefusal(stateFor("ship", { git: { branch: "livespec/per-ip-cap", head: "f", dirty: true, specsChanged: false } }, body))).toContain("clean");
		expect(shipLocalRefusal(stateFor("ship", { git: { branch: "main", head: "f", dirty: false, specsChanged: false } }, body))).toContain("livespec/per-ip-cap");
	});
});

describe("staleShipId", () => {
	const comment = { id: "12", author: "a", body: "b", createdAt: "2026-01-01T00:00:01.000Z", updatedAt: "2026-01-01T00:00:02.000Z", version: "v" as PullRequest["version"] };
	test("a comment id holds the ship gate's comment, the comment's id and updatedAt; a digest holds the gate and the digest", () => {
		expect(staleShipId({ kind: "comment", reason: "r", comment }, "g7")).toBe("stale.ship.g7.12-2026-01-01T000002.000Z");
		expect(staleShipId({ kind: "digest", reason: "r", digest: "ab" }, "g7")).toBe("stale.ship.g7.digest.ab");
	});
	test("another ship gate comment gives another id", () => {
		expect(staleShipId({ kind: "digest", reason: "r", digest: "ab" }, "g8")).not.toBe(staleShipId({ kind: "digest", reason: "r", digest: "ab" }, "g7"));
	});
	test("characters outside the marker id charset drop out of the gate id", () => {
		expect(staleShipId({ kind: "digest", reason: "r", digest: "ab" }, "IC_k w/x:1")).toBe("stale.ship.ICkwx1.digest.ab");
	});
});

describe("forge text in refusals is untrusted", () => {
	test("a foreign pull request's author and head are wrapped", () => {
		const open = [{ number: 5, author: "evil", head: "x<y", body: "", state: "open" }] as unknown as PullRequest[];
		const choice = pullRequestChoice(open, { login: "me", change: 1 });
		expect(choice).toMatchObject({ kind: "refused", reason: expect.stringContaining("<untrusted>evil</untrusted>") });
		expect(choice.kind === "refused" && choice.reason).toContain("<untrusted>x&lt;y</untrusted>");
	});
});
