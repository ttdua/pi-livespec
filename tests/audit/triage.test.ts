// drift-audit "Drift re-triage".

import { describe, expect, test } from "vitest";
import type { ClassifiedItem } from "../../src/audit/severity.ts";
import { applyTriage } from "../../src/audit/triage.ts";
import type { Comment, Version } from "../../src/forge/types.ts";

const TERM: ClassifiedItem = { type: "unused-term", key: "unused-term:Bucket", subject: "Bucket", evidence: "used nowhere", severity: "minor", route: "small-fix" };
const DEAD: ClassifiedItem = { type: "dead-paths", key: "dead-paths:rate-limit:src/gone/**", subject: "rate-limit:src/gone/**", capability: "rate-limit", evidence: "matches no file", severity: "major", route: "change" };

let id = 0;
const comment = (author: string, body: string): Comment => {
	id += 1;
	const at = new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString();
	return { id: String(id), author, body, createdAt: at, updatedAt: at, version: "v" as Version };
};

const WRITERS = new Map([["wanda", "write"], ["adam", "admin"], ["rita", "read"]]);
const canWrite = async (login: string) => ["write", "admin"].includes(WRITERS.get(login) ?? "none");

describe("applyTriage", () => {
	test("Minor raised to major", async () => {
		const out = await applyTriage([TERM, DEAD], [comment("wanda", "/livespec triage unused-term:Bucket major")], canWrite);
		expect(out.items.find((i) => i.key === TERM.key)).toEqual({ ...TERM, severity: "major", route: "change", retriaged: { by: "wanda", from: "minor" } });
		expect(out.items.find((i) => i.key === DEAD.key)).toEqual(DEAD);
	});

	test("Major lowered to minor", async () => {
		const out = await applyTriage([TERM, DEAD], [comment("adam", "/livespec triage dead-paths:rate-limit:src/gone/** minor\nit is planned")], canWrite);
		expect(out.items.find((i) => i.key === DEAD.key)).toEqual({ ...DEAD, severity: "minor", route: "small-fix", retriaged: { by: "adam", from: "major" } });
	});

	test("Reader without write access", async () => {
		const out = await applyTriage([TERM], [comment("rita", "/livespec triage unused-term:Bucket major")], canWrite);
		expect(out).toEqual({ items: [TERM], ignored: [], unmatched: [] });
	});

	test("ignore moves the item to the ignored list; the latest command per key wins", async () => {
		const out = await applyTriage([TERM, DEAD], [
			comment("wanda", "/livespec triage unused-term:Bucket major"),
			comment("adam", "/livespec triage unused-term:Bucket ignore"),
		], canWrite);
		expect(out.items).toEqual([DEAD]);
		expect(out.ignored).toEqual([TERM.key]);
	});

	test("unmatched key listed", async () => {
		const out = await applyTriage([TERM], [comment("wanda", "/livespec triage unused-term:Gone minor")], canWrite);
		expect(out.unmatched).toEqual(["unused-term:Gone"]);
		expect(out.items).toEqual([TERM]);
	});

	test("other comments and malformed commands are ignored; permission read once per author", async () => {
		const asked: string[] = [];
		const out = await applyTriage([TERM], [
			comment("wanda", "looks fine"),
			comment("wanda", "/livespec triage unused-term:Bucket huge"),
			comment("wanda", "see /livespec triage unused-term:Bucket major"),
			comment("wanda", "/livespec approve"),
		], async (l) => (asked.push(l), canWrite(l)));
		expect(out).toEqual({ items: [TERM], ignored: [], unmatched: [] });
		expect(asked.length).toBeLessThanOrEqual(1);
	});
});

describe("applyTriage multi-word keys", () => {
	const SCENARIO: ClassifiedItem = { type: "scenario-untested", key: "scenario-untested:rate-limit/rejects 101st request", subject: "rate-limit/rejects 101st request", capability: "rate-limit", evidence: "named in no test", severity: "minor", route: "small-fix" };

	test("a writer re-triages a key containing spaces", async () => {
		const out = await applyTriage([SCENARIO], [comment("wanda", `/livespec triage ${SCENARIO.key} ignore`)], canWrite);
		expect(out).toEqual({ items: [], ignored: [SCENARIO.key], unmatched: [] });
	});

	test("a reader cannot re-triage a key containing spaces", async () => {
		const out = await applyTriage([SCENARIO], [comment("rita", `/livespec triage ${SCENARIO.key} major`)], canWrite);
		expect(out).toEqual({ items: [SCENARIO], ignored: [], unmatched: [] });
	});
});
