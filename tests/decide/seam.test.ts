import { beforeEach, describe, expect, test } from "vitest";
import { registerBuiltinRules, registerRule, resetRulesForTests } from "../../src/decide/registry.ts";
import { type DecisionAsk, decide } from "../../src/decide/seam.ts";
import { resetRegistryForTests } from "../../src/engine/registry.ts";

const OPTIONS = [
	{ id: "x", label: "Option X" },
	{ id: "y", label: "Option Y" },
];

beforeEach(() => {
	resetRegistryForTests();
	resetRulesForTests();
	registerBuiltinRules();
	registerRule("pick", { validate() {} }, () => ({ ask: { summary: "Pick one", options: OPTIONS } }));
});

describe("decide", () => {
	test("Rule outcome", async () => {
		const facts = { tags: [], covers: ["cap/Requirement: A"], files: ["src/a.ts"] };
		const r = await decide("difficulty", facts, { config: { mode: "rule" }, subject: "U1" });
		expect(r).toMatchObject({ status: "decided", outcome: "low", source: "rule", facts });
		if (r.status !== "decided") return;
		expect(r.reason).toContain("1 file");
		expect(r.reason).toContain("tags []");
	});

	test("Rule asks", async () => {
		const asked: DecisionAsk[] = [];
		const facts = { n: 1 };
		const r = await decide("pick", facts, {
			config: { mode: "rule" },
			subject: "U2",
			ask: async (intent) => {
				asked.push(intent);
				return { status: "answered", outcome: "approved", choice: "y", by: "alice", at: "2026-01-01T00:00:00Z" };
			},
		});
		expect(asked).toEqual([{ point: "pick", subject: "U2", facts, summary: "Pick one", options: OPTIONS }]);
		expect(r).toMatchObject({ status: "decided", outcome: "y", source: "human", facts });
		if (r.status === "decided") expect(r.reason).toContain("alice");
	});

	test("a recorded answer decides as human", async () => {
		const facts = { n: 2 };
		const r = await decide("pick", facts, {
			config: { mode: "rule" },
			subject: "U2",
			ask: async () => ({ status: "recorded", outcome: "y", reason: "r" }),
		});
		expect(r).toEqual({ status: "decided", outcome: "y", source: "human", reason: "r", facts });
	});

	test("the digest reaches the ask", async () => {
		const asked: DecisionAsk[] = [];
		await decide("pick", { n: 1 }, {
			config: { mode: "rule" },
			subject: "U1",
			digest: "d1",
			ask: async (intent) => {
				asked.push(intent);
				return { status: "pending", requestId: "r1" };
			},
		});
		expect(asked[0]).toMatchObject({ digest: "d1" });
	});

	test("Rule decision ignores a human record", async () => {
		registerRule("deciding", { validate() {} }, () => ({ outcome: "x", reason: "rule" }));
		const ask = async (): Promise<never> => {
			throw new Error("ask must not run for a deciding rule");
		};
		const r = await decide("deciding", {}, { config: {}, subject: "U1", digest: "d1", ask });
		expect(r).toMatchObject({ status: "decided", outcome: "x", source: "rule" });
	});

	test("pending ask returns the request id", async () => {
		const r = await decide("pick", {}, { config: {}, subject: "U2", ask: async () => ({ status: "pending", requestId: "decide-pick-U2.abc" }) });
		expect(r).toEqual({ status: "pending", requestId: "decide-pick-U2.abc" });
	});

	test("ask without an approver throws", async () => {
		await expect(decide("pick", {}, { config: {}, subject: "U2" })).rejects.toThrow(/approver/);
	});

	test("answer without a choice throws", async () => {
		const ask = async () => ({ status: "answered" as const, outcome: "dismissed", by: "alice", at: "t" });
		await expect(decide("pick", {}, { config: {}, subject: "U2", ask })).rejects.toThrow(/choice/);
	});

	test("rule data is passed through", async () => {
		const facts = { title: "t", covers: [], files: ["src/auth/a.ts"], doneMeans: [], extraTags: ["api"] };
		const config = { mode: "rule", paths: { security: ["**/auth/**"] }, keywords: {} };
		const r = await decide("tags", facts, { config, subject: "U3" });
		expect(r).toMatchObject({ status: "decided", outcome: ["security", "api"], source: "rule", data: { agentAdditions: ["api"] } });
	});

	test("unregistered point throws", async () => {
		await expect(decide("nope", {}, { config: {}, subject: "x" })).rejects.toThrow(/nope/);
	});
});

describe("rule ask briefing", () => {
	const ask = async () => ({ status: "pending" as const, requestId: "r" });
	const run = (point: string) => decide(point, {}, { config: { mode: "rule" }, subject: "U1", ask });

	test("Rule recommends an option it does not offer", async () => {
		registerRule("bad-rec", { validate() {} }, () => ({ ask: { summary: "s", options: OPTIONS, recommended: "z", rationale: "why" } }));
		await expect(run("bad-rec")).rejects.toThrow("decision `bad-rec` recommends `z`, which it does not offer");
	});

	test("a recommending rule with an over-long summary throws naming the rule", async () => {
		registerRule("long-sum", { validate() {} }, () => ({ ask: { summary: "s".repeat(601), options: OPTIONS, recommended: "x", rationale: "why" } }));
		await expect(run("long-sum")).rejects.toThrow(/decision `long-sum` .*600/);
	});

	test("a recommending rule with a multi-paragraph rationale throws naming the rule", async () => {
		registerRule("blank-rat", { validate() {} }, () => ({ ask: { summary: "s", options: OPTIONS, recommended: "x", rationale: "a\n\nb" } }));
		await expect(run("blank-rat")).rejects.toThrow(/decision `blank-rat` /);
	});

	test("a rule without a recommendation keeps a long summary", async () => {
		registerRule("long-plain", { validate() {} }, () => ({ ask: { summary: "s".repeat(601), options: OPTIONS } }));
		await expect(run("long-plain")).resolves.toEqual({ status: "pending", requestId: "r" });
	});

	test("a rule option description over 200 code points throws", async () => {
		registerRule("long-desc", { validate() {} }, () => ({ ask: { summary: "s", options: [{ id: "x", label: "X", description: "d".repeat(201) }] } }));
		await expect(run("long-desc")).rejects.toThrow(/decision `long-desc`/);
	});

	test("a valid recommendation reaches the asker", async () => {
		registerRule("good-rec", { validate() {} }, () => ({ ask: { summary: "s", options: OPTIONS, recommended: "x", rationale: "why" } }));
		const seen: DecisionAsk[] = [];
		await decide("good-rec", {}, { config: { mode: "rule" }, subject: "U1", ask: async (i) => (seen.push(i), { status: "pending" as const, requestId: "r" }) });
		expect(seen[0]).toMatchObject({ recommended: "x", rationale: "why" });
	});
});
