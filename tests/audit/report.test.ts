// drift-audit "Drift report output".

import { describe, expect, test } from "vitest";
import { type AuditReport, deliverReport, DRIFT_REPORT_KIND, renderReport } from "../../src/audit/report.ts";
import type { ClassifiedItem } from "../../src/audit/severity.ts";
import { parseMarked, writeMarked } from "../../src/forge/markers.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";

const COMMIT = "b".repeat(40);
const MAJOR: ClassifiedItem = { type: "dead-paths", key: "dead-paths:rate-limit:src/gone/**", subject: "rate-limit:src/gone/**", capability: "rate-limit", evidence: "matches no file", severity: "major", route: "change" };
const MINOR: ClassifiedItem = { type: "unused-term", key: "unused-term:Bucket", subject: "Bucket", evidence: "used nowhere", severity: "minor", route: "small-fix", retriaged: { by: "carol", from: "major" } };
const UNCONFIRMED: ClassifiedItem = { type: "scenario-untested", key: "scenario-untested:rate-limit/x", subject: "rate-limit/x", capability: "rate-limit", evidence: "named in no test", confirmed: false, severity: "major", route: "change" };

const report = (over: Partial<AuditReport> = {}): AuditReport => ({ commit: COMMIT, refreshed: true, items: [MINOR, MAJOR], refuted: [], ignored: [], unmatched: [], notes: [], ...over });

describe("renderReport", () => {
	test("major before minor, one line per item, refuted, ignored, unmatched and notes", () => {
		const text = renderReport(report({
			items: [MINOR, MAJOR, UNCONFIRMED],
			refuted: [{ key: "scenario-untested:rate-limit/y", reason: "tested as y2" }],
			ignored: ["stale-decision:0002-x@specs/product.md"],
			unmatched: ["unused-term:Gone"],
			notes: ["declared-none skipped: the forge is unavailable"],
		}));
		expect(text).toContain(COMMIT);
		const lines = text.split("\n");
		const majorAt = lines.findIndex((l) => l.includes(MAJOR.key));
		const minorAt = lines.findIndex((l) => l.includes(MINOR.key));
		expect(majorAt).toBeGreaterThan(-1);
		expect(majorAt).toBeLessThan(minorAt);
		expect(lines[majorAt]).toBe(`- [major] ${MAJOR.key} — ${MAJOR.evidence} → change`);
		expect(lines[minorAt]).toContain("re-triaged by carol from major");
		expect(lines.find((l) => l.includes(UNCONFIRMED.key))).toContain("unconfirmed");
		expect(text).toContain("Refuted by the scout");
		expect(text).toContain("tested as y2");
		expect(text).toContain("Ignored");
		expect(text).toContain("stale-decision:0002-x@specs/product.md");
		expect(text).toContain("unused-term:Gone");
		expect(text).toContain("declared-none skipped");
		expect(text).toMatch(/routes are suggestions/i);
		expect(text).toMatch(/changed nothing/i);
	});

	test("a snapshot that was not refreshed names the fetch error", () => {
		expect(renderReport(report({ refreshed: false, fetchError: "could not resolve host" }))).toMatch(/not refreshed.*could not resolve host/);
	});

	test("unmatched keys, read from forge comments, are wrapped as untrusted", () => {
		const text = renderReport(report({ unmatched: ["unused-term:<script>"] }));
		expect(text).not.toContain("<script>");
		expect(text).toContain("<untrusted>unused-term:&lt;script></untrusted>");
	});
});

describe("deliverReport", () => {
	test("Posted on the initiative", async () => {
		const world = new MemoryWorld();
		const n = await world.seedIssue({ title: "initiative" });
		const r = report();
		const out = await deliverReport(r, { forge: world.forge, writable: true, target: n });
		expect(out.posted).toBe(n);
		const comments = await world.forge.listComments(n);
		expect(comments).toHaveLength(1);
		expect(comments[0]?.author).toBe(BOT_LOGIN);
		const marked = parseMarked(comments[0]?.body ?? "");
		expect(marked?.kind).toBe(DRIFT_REPORT_KIND);
		expect(marked?.id).toMatch(new RegExp(`^drift-report\\.${COMMIT.slice(0, 12)}\\.[0-9a-z]+$`));
		const data = marked?.data as { commit: string; items: ClassifiedItem[]; refuted: unknown[]; ignored: string[] };
		expect(data.commit).toBe(COMMIT);
		expect(data.items.map((i) => i.key)).toEqual([MINOR.key, MAJOR.key]);
		expect(comments[0]?.body).toContain(renderReport(r));
		expect(out.text).toContain(renderReport(r));
	});

	test("No initiative", async () => {
		const world = new MemoryWorld();
		const n = await world.seedIssue({ title: "initiative" });
		const out = await deliverReport(report(), { forge: world.forge, writable: true });
		expect(out.posted).toBeUndefined();
		expect(out.text).toMatch(/no initiative/i);
		expect(await world.forge.listComments(n)).toEqual([]);
	});

	test("read-only or missing forge prints only, saying why", async () => {
		const world = new MemoryWorld();
		const n = await world.seedIssue({ title: "initiative" });
		const readOnly = await deliverReport(report(), { forge: world.forge, writable: false, target: n });
		expect(readOnly.posted).toBeUndefined();
		expect(readOnly.text).toMatch(/read-only/i);
		const none = await deliverReport(report(), { writable: false, target: n });
		expect(none.text).toMatch(/no forge/i);
		expect(await world.forge.listComments(n)).toEqual([]);
	});

	test("a failed post still prints the report, saying why", async () => {
		const world = new MemoryWorld();
		const n = await world.seedIssue({ title: "initiative" });
		await world.makeUnreachable();
		const out = await deliverReport(report(), { forge: world.forge, writable: true, target: n });
		expect(out.posted).toBeUndefined();
		expect(out.text).toContain(renderReport(report()));
		expect(out.text).toMatch(/could not be posted.*connection refused/);
	});

	test("Marker kind registered", () => {
		expect(() => writeMarked(DRIFT_REPORT_KIND, "drift-report.abc.1", { commit: COMMIT, items: [], refuted: [], ignored: [] })).not.toThrow();
	});
});
