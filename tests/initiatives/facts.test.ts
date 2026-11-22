import { describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { parseInitiative } from "../../src/core/initiative.ts";
import type { DepState } from "../../src/engine/deps-facts.ts";
import type { Issue, Version } from "../../src/forge/types.ts";
import { capabilityOverlap, initiativeProgress } from "../../src/initiatives/facts.ts";

function issue(number: number, title: string, body: string): Issue {
	return { number, title, body, labels: ["livespec"], state: "open", author: "a", updatedAt: "", version: "cv:1" as Version };
}

const target = (body: string) => ({ issue: { number: 35 }, change: parseChange(body) });

describe("capabilityOverlap", () => {
	test("capability overlap lists #36 sharing rate-limit", () => {
		const open = [
			issue(35, "per-ip-cap", "Branch: livespec/per-ip-cap\nCapabilities: new [], modified [rate-limit]\n"),
			issue(36, "burst", "Branch: livespec/burst\nCapabilities: new [], modified [rate-limit, audit-log]\n"),
			issue(37, "no-branch", "Capabilities: new [], modified [rate-limit]\n"),
			issue(38, "other", "Branch: livespec/other\nCapabilities: new [billing], modified []\n"),
		];
		const overlap = capabilityOverlap(target("Branch: livespec/per-ip-cap\nCapabilities: new [], modified [rate-limit]\n"), open);
		expect(overlap).toEqual([{ number: 36, title: "burst", capabilities: ["rate-limit"] }]);
	});

	test("a new capability counts like a modified one", () => {
		const open = [issue(36, "burst", "Branch: livespec/burst\nCapabilities: new [quota], modified []\n")];
		expect(capabilityOverlap(target("Capabilities: new [], modified [quota]\n"), open)).toEqual([{ number: 36, title: "burst", capabilities: ["quota"] }]);
	});
});

describe("initiativeProgress", () => {
	const body = "Goal: g\nCapabilities: [rate-limit]\n\n## Changes\n- [x] #34 audit-log — Depends: —\n- [ ] #35 per-ip-cap — Depends: #34\n- [ ] #36 burst — Depends: #34\n- [ ] #37 admin — Depends: #36\n- [ ] #38 started — Depends: —\n";

	test("counts checked entries and lists the ready, not started ones", () => {
		const open = [
			issue(35, "per-ip-cap", "Branch: livespec/per-ip-cap\n"),
			issue(36, "burst", "Depends: #34\n"),
			issue(37, "admin", "Depends: #36\n"),
			issue(38, "started", "Branch: livespec/started\n"),
		];
		const known = new Map<number, DepState>([[34, "merged"]]);
		expect(initiativeProgress(30, parseInitiative(body), 35, known, open)).toEqual({ number: 30, checked: 1, total: 5, ready: [{ number: 36, name: "burst" }] });
	});
});
