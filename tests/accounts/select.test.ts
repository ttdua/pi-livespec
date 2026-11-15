import { describe, expect, it } from "vitest";
import { selectAccount } from "../../src/accounts/select.ts";
import type { Access, SelectionFacts } from "../../src/accounts/types.ts";

const REMOTE = "github.com/acme/widgets";

function cand(name: string, access: Access): SelectionFacts["candidates"][number] {
	return { candidate: { name, user: name }, access };
}

function facts(over: Partial<SelectionFacts> = {}): SelectionFacts {
	return { forge: "github", envToken: false, remote: REMOTE, candidates: [], hasUI: true, ...over };
}

const stored = (account: string, remote = REMOTE) => ({ account, remote });

describe("selectAccount", () => {
	it("Active account ignored", () => {
		const result = selectAccount(facts({ candidates: [cand("naicoi92", "false"), cand("ttdua", "true")] }));
		expect(result).toEqual({ kind: "store", account: "ttdua", source: "auto" });
	});

	it("Tea default ignored", () => {
		const result = selectAccount(
			facts({ forge: "gitea", remote: "gitea.example.org/acme/shop", candidates: [cand("gitea.example.org", "true"), cand("gitea-admin", "true")] }),
		);
		expect(result).toEqual({ kind: "ask", options: ["gitea.example.org", "gitea-admin"] });
	});

	it("Environment token wins", () => {
		const result = selectAccount(facts({ envToken: true, stored: stored("ttdua"), candidates: [cand("ttdua", "true")] }));
		expect(result).toEqual({ kind: "env" });
	});

	it("Other forge's token ignored", () => {
		const result = selectAccount(
			facts({ forge: "gitea", envToken: false, remote: "gitea.example.org/acme/shop", candidates: [cand("gitea.example.org", "true")] }),
		);
		expect(result).toEqual({ kind: "store", account: "gitea.example.org", source: "auto" });
	});

	it("Stored account reused", () => {
		const result = selectAccount(facts({ stored: stored("ttdua"), candidates: [cand("naicoi92", "true"), cand("ttdua", "true")] }));
		expect(result).toEqual({ kind: "use", account: "ttdua", source: "stored", unverified: false });
	});

	it("Single writer chosen automatically", () => {
		const result = selectAccount(facts({ candidates: [cand("ttdua", "true"), cand("naicoi92", "false")] }));
		expect(result).toEqual({ kind: "store", account: "ttdua", source: "auto" });
	});

	it("Several writers with UI", () => {
		const result = selectAccount(facts({ candidates: [cand("ttdua", "true"), cand("naicoi92", "true")] }));
		expect(result).toEqual({ kind: "ask", options: ["ttdua", "naicoi92"] });
	});

	it("Several writers without UI", () => {
		const result = selectAccount(facts({ hasUI: false, candidates: [cand("ttdua", "true"), cand("naicoi92", "true")] }));
		expect(result).toEqual({ kind: "refuse", reason: "ambiguous", options: ["ttdua", "naicoi92"] });
	});

	it("No writer", () => {
		expect(selectAccount(facts({ candidates: [cand("ttdua", "false")] }))).toEqual({ kind: "refuse", reason: "no-access", options: ["ttdua"] });
		expect(selectAccount(facts())).toEqual({ kind: "refuse", reason: "no-candidates", options: [] });
	});

	it("Stale stored account", () => {
		const result = selectAccount(facts({ stored: stored("ttdua"), candidates: [cand("ttdua", "false"), cand("naicoi92", "true")] }));
		expect(result).toEqual({ kind: "store", account: "naicoi92", source: "auto" });
	});

	it("Stored account disappeared", () => {
		const result = selectAccount(facts({ stored: stored("gone"), candidates: [cand("naicoi92", "true")] }));
		expect(result).toEqual({ kind: "store", account: "naicoi92", source: "auto" });
	});

	it("Remote changed", () => {
		const result = selectAccount(facts({ stored: stored("ttdua", "github.com/acme/other"), candidates: [cand("ttdua", "true"), cand("naicoi92", "false")] }));
		expect(result).toEqual({ kind: "store", account: "ttdua", source: "auto" });
		const unknown = selectAccount(facts({ stored: stored("ttdua", "github.com/acme/other"), candidates: [cand("ttdua", "unknown")] }));
		expect(unknown.kind).toBe("refuse");
	});

	it("Offline with stored account", () => {
		const result = selectAccount(facts({ stored: stored("ttdua"), candidates: [cand("ttdua", "unknown"), cand("naicoi92", "false")] }));
		expect(result).toEqual({ kind: "use", account: "ttdua", source: "stored", unverified: true });
	});

	it("Unknown stored account loses to a writer", () => {
		const result = selectAccount(facts({ stored: stored("ttdua"), candidates: [cand("ttdua", "unknown"), cand("naicoi92", "true")] }));
		expect(result).toEqual({ kind: "store", account: "naicoi92", source: "auto" });
	});

	it("Denied stored account not revived", () => {
		const result = selectAccount(facts({ stored: stored("ttdua"), candidates: [cand("ttdua", "false"), cand("naicoi92", "unknown")] }));
		expect(result).toEqual({ kind: "refuse", reason: "no-access", options: ["ttdua", "naicoi92"] });
	});

	it("stored name invalid for the forge is ignored", () => {
		const bad = stored("-bad name");
		expect(selectAccount(facts({ stored: bad, candidates: [cand("ttdua", "true")] }))).toEqual({ kind: "store", account: "ttdua", source: "auto" });
		expect(selectAccount(facts({ stored: bad, candidates: [cand("ttdua", "false")] }))).toEqual({ kind: "refuse", reason: "invalid", options: ["ttdua"] });
		const underscore = stored("a_b");
		expect(selectAccount(facts({ stored: underscore, candidates: [cand("a_b", "unknown")] })).kind).toBe("refuse");
	});

	it("pure: equal inputs give deep-equal results", () => {
		const make = () => facts({ stored: stored("ttdua"), candidates: [cand("ttdua", "false"), cand("naicoi92", "true")] });
		expect(selectAccount(make())).toEqual(selectAccount(make()));
	});
});
