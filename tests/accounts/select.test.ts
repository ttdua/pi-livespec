import { describe, expect, it } from "vitest";
import { selectAccount } from "../../src/accounts/select.ts";
import type { Access, SelectionFacts, SelectionResult } from "../../src/accounts/types.ts";

const REMOTE = "github.com/acme/widgets";
const GITEA_REMOTE = "gitea.example.org/acme/shop";

function cand(name: string, access: Access): SelectionFacts["candidates"][number] {
	return { candidate: { name, user: name }, access };
}

function facts(over: Partial<SelectionFacts> = {}): SelectionFacts {
	return { forge: "github", envToken: false, remote: REMOTE, candidates: [], hasUI: true, ...over };
}

const stored = (account: string, remote = REMOTE) => ({ account, remote });
const store = (account: string): SelectionResult => ({ kind: "store", account, source: "auto" });

/** One row per spec scenario; a row may hold several fact/result pairs of the same scenario. */
const SCENARIOS: { name: string; cases: [SelectionFacts, SelectionResult][] }[] = [
	{
		name: "Active account ignored",
		cases: [[facts({ candidates: [cand("naicoi92", "false"), cand("ttdua", "true")] }), store("ttdua")]],
	},
	{
		name: "Tea default ignored",
		cases: [
			[
				facts({ forge: "gitea", remote: GITEA_REMOTE, candidates: [cand("gitea.example.org", "true"), cand("gitea-admin", "true")] }),
				{ kind: "ask", options: ["gitea.example.org", "gitea-admin"] },
			],
		],
	},
	{
		name: "Environment token wins",
		cases: [[facts({ envToken: true, stored: stored("ttdua"), candidates: [cand("ttdua", "true")] }), { kind: "env" }]],
	},
	{
		name: "Other forge's token ignored",
		cases: [
			[
				facts({ forge: "gitea", envToken: false, remote: GITEA_REMOTE, candidates: [cand("gitea.example.org", "true")] }),
				store("gitea.example.org"),
			],
		],
	},
	{
		name: "Stored account reused",
		cases: [
			[
				facts({ stored: stored("ttdua"), candidates: [cand("naicoi92", "true"), cand("ttdua", "true")] }),
				{ kind: "use", account: "ttdua", source: "stored", unverified: false },
			],
		],
	},
	{
		name: "Single writer chosen automatically",
		cases: [[facts({ candidates: [cand("ttdua", "true"), cand("naicoi92", "false")] }), store("ttdua")]],
	},
	{
		name: "Several writers with UI",
		cases: [[facts({ candidates: [cand("ttdua", "true"), cand("naicoi92", "true")] }), { kind: "ask", options: ["ttdua", "naicoi92"] }]],
	},
	{
		name: "Several writers without UI",
		cases: [
			[
				facts({ hasUI: false, candidates: [cand("ttdua", "true"), cand("naicoi92", "true")] }),
				{ kind: "refuse", reason: "ambiguous", options: ["ttdua", "naicoi92"] },
			],
		],
	},
	{
		name: "No writer",
		cases: [
			[facts({ candidates: [cand("ttdua", "false")] }), { kind: "refuse", reason: "no-access", options: ["ttdua"] }],
			[facts(), { kind: "refuse", reason: "no-candidates", options: [] }],
		],
	},
	{
		name: "Stale stored account",
		cases: [[facts({ stored: stored("ttdua"), candidates: [cand("ttdua", "false"), cand("naicoi92", "true")] }), store("naicoi92")]],
	},
	{
		name: "Stored account disappeared",
		cases: [[facts({ stored: stored("gone"), candidates: [cand("naicoi92", "true")] }), store("naicoi92")]],
	},
	{
		name: "Remote changed",
		cases: [
			[facts({ stored: stored("ttdua", "github.com/acme/other"), candidates: [cand("ttdua", "true"), cand("naicoi92", "false")] }), store("ttdua")],
			[
				facts({ stored: stored("ttdua", "github.com/acme/other"), candidates: [cand("ttdua", "unknown")] }),
				{ kind: "refuse", reason: "no-access", options: ["ttdua"] },
			],
		],
	},
	{
		name: "Offline with stored account",
		cases: [
			[
				facts({ stored: stored("ttdua"), candidates: [cand("ttdua", "unknown"), cand("naicoi92", "false")] }),
				{ kind: "use", account: "ttdua", source: "stored", unverified: true },
			],
		],
	},
	{
		name: "Unknown stored account loses to a writer",
		cases: [[facts({ stored: stored("ttdua"), candidates: [cand("ttdua", "unknown"), cand("naicoi92", "true")] }), store("naicoi92")]],
	},
	{
		name: "Denied stored account not revived",
		cases: [
			[
				facts({ stored: stored("ttdua"), candidates: [cand("ttdua", "false"), cand("naicoi92", "unknown")] }),
				{ kind: "refuse", reason: "no-access", options: ["ttdua", "naicoi92"] },
			],
		],
	},
];

describe("selectAccount", () => {
	it.each(SCENARIOS)("$name", ({ cases }) => {
		for (const [input, expected] of cases) expect(selectAccount(input)).toEqual(expected);
	});

	it("stored name invalid for the forge is ignored", () => {
		const invalidNames: [SelectionFacts["forge"], string][] = [
			["github", "-bad name"],
			["github", "a_b"],
			["gitea", "-bad"],
		];
		const candidateSets = {
			"one writer": [cand("ttdua", "true")],
			"no writer": [cand("ttdua", "false")],
			"several writers": [cand("ttdua", "true"), cand("naicoi92", "true")],
			"unknown only": [cand("a_b", "unknown"), cand("-bad", "unknown")],
		};
		for (const [forge, name] of invalidNames) {
			for (const [label, candidates] of Object.entries(candidateSets)) {
				for (const remote of [REMOTE, "github.com/acme/old"]) {
					const without = facts({ forge, candidates });
					const withInvalid = facts({ forge, candidates, stored: stored(name, remote) });
					expect(selectAccount(withInvalid), `${forge} ${name} ${label} ${remote}`).toEqual(selectAccount(without));
				}
			}
		}
		expect(selectAccount(facts({ stored: stored("-bad"), candidates: [cand("ttdua", "false")] })).kind).toBe("refuse");
	});

	it("pure: equal inputs give deep-equal results", () => {
		const make = () => facts({ stored: stored("ttdua"), candidates: [cand("ttdua", "false"), cand("naicoi92", "true")] });
		expect(selectAccount(make())).toEqual(selectAccount(make()));
	});
});
