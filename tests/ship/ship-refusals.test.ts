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
	test("a comment id holds the comment's id and updatedAt; a digest holds the digest", () => {
		const comment = { id: "12", author: "a", body: "b", createdAt: "2026-01-01T00:00:01.000Z", updatedAt: "2026-01-01T00:00:02.000Z", version: "v" as PullRequest["version"] };
		expect(staleShipId({ kind: "comment", reason: "r", comment })).toBe("stale.ship.12-2026-01-01T000002.000Z");
		expect(staleShipId({ kind: "digest", reason: "r", digest: "ab" })).toBe("stale.ship.digest.ab");
	});
});
