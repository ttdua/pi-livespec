import { describe, expect, test } from "vitest";
import type { Lock } from "../../src/content/lock.ts";
import { type UpgradeInput, decideUpgrade, upgradeGate } from "../../src/content/upgrade.ts";
import { DEFAULT_CHANNEL } from "../../src/config.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const NOW = new Date("2026-11-14T12:00:00Z");
const HOURS_AGO = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const lock = (over: Partial<Lock> = {}): Lock => ({
	source: "https://github.com/addyosmani/agent-skills",
	commit: A,
	pinned: null,
	history: [A],
	skipped: [],
	checkedAt: HOURS_AGO(25),
	...over,
});

const input = (over: Partial<UpgradeInput> = {}): UpgradeInput => ({
	channel: "auto",
	lock: lock(),
	now: NOW,
	head: B,
	workInProgress: { busy: false },
	manual: false,
	...over,
});

const BUSY = { busy: true, change: 42, reason: "change #42 is in build with pending unit U2" };

describe("decideUpgrade", () => {
	const cases: { name: string; i: UpgradeInput; kind: "skip" | "notify" | "install"; reason?: RegExp }[] = [
		{ name: "Default channel", i: input({ channel: DEFAULT_CHANNEL }), kind: "install" },
		{ name: "Notify channel", i: input({ channel: "notify" }), kind: "notify" },
		{ name: "Pinned", i: input({ lock: lock({ pinned: A }) }), kind: "skip", reason: /pinned/ },
		{ name: "pinned channel skips without a lock pin", i: input({ channel: "pinned" }), kind: "skip", reason: /pinned/ },
		{ name: "Throttled", i: input({ lock: lock({ checkedAt: HOURS_AGO(1) }) }), kind: "skip", reason: /24 hours/ },
		{ name: "never checked is not throttled", i: input({ lock: lock({ checkedAt: null }) }), kind: "install" },
		{ name: "Build in progress", i: input({ workInProgress: BUSY }), kind: "skip", reason: /#42/ },
		{ name: "Skipped commit not reinstalled", i: input({ lock: lock({ skipped: [B] }) }), kind: "skip", reason: /skipped/ },
		{ name: "head equal to the current commit", i: input({ head: A }), kind: "skip", reason: /already/ },
		{ name: "manual ignores the 24h limit", i: input({ manual: true, lock: lock({ checkedAt: HOURS_AGO(1) }) }), kind: "install" },
		{ name: "manual installs on the notify channel", i: input({ manual: true, channel: "notify" }), kind: "install" },
		{ name: "manual refused while pinned", i: input({ manual: true, lock: lock({ pinned: A }) }), kind: "skip", reason: /unpin/ },
		{ name: "manual refused during work in progress", i: input({ manual: true, workInProgress: BUSY }), kind: "skip", reason: /#42/ },
	];

	for (const c of cases) {
		test(c.name, () => {
			const d = decideUpgrade(c.i);
			expect(d.kind).toBe(c.kind);
			if (d.kind === "skip") expect(d.reason).toMatch(c.reason ?? /^$/);
			else expect(d.sha).toBe(c.i.head);
		});
	}
});

describe("upgradeGate", () => {
	test("is open when nothing blocks a fetch", () => {
		expect(upgradeGate(input())).toBeUndefined();
	});

	test("closes on throttle, pin and work in progress before any fetch", () => {
		expect(upgradeGate(input({ lock: lock({ checkedAt: HOURS_AGO(23) }) }))?.kind).toBe("skip");
		expect(upgradeGate(input({ lock: lock({ pinned: A }) }))?.kind).toBe("skip");
		expect(upgradeGate(input({ workInProgress: BUSY }))?.kind).toBe("skip");
	});
});
