// The drift report: its rendering, the `drift-report` marker comment and where it goes.

import { messageOf } from "../core/messages.ts";
import { registerKind, writeMarked } from "../forge/markers.ts";
import type { Forge } from "../forge/types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import type { Refuted } from "./confirm.ts";
import type { ClassifiedItem, Severity } from "./severity.ts";

export const DRIFT_REPORT_KIND = "drift-report";
registerKind(DRIFT_REPORT_KIND);

export type AuditReport = {
	commit: string;
	refreshed: boolean;
	fetchError?: string;
	items: ClassifiedItem[];
	refuted: Refuted[];
	ignored: string[];
	unmatched: string[];
	notes: string[];
};

/** Where a report goes: posted on `target` when the forge is connected and writable, otherwise printed only. */
export type ReportDestination = { forge?: Pick<Forge, "createComment">; writable: boolean; target?: number };

const SHORT_SHA = 12;
const SEVERITIES: readonly Severity[] = ["major", "minor"];
const DISCLAIMER = "Routes are suggestions; the audit changed nothing.";

function itemLine(item: ClassifiedItem): string {
	const marks = [item.confirmed === false ? "unconfirmed" : "", item.retriaged ? `re-triaged by ${item.retriaged.by} from ${item.retriaged.from}` : ""].filter(Boolean);
	return `- [${item.severity}] ${item.key} — ${item.evidence} → ${item.route}${marks.length === 0 ? "" : ` (${marks.join("; ")})`}`;
}

const section = (title: string, lines: string[]): string[] => (lines.length === 0 ? [] : ["", `${title}:`, ...lines]);

function snapshotLine(r: AuditReport): string {
	const at = `Audited commit: ${r.commit}`;
	return r.refreshed ? at : `${at} (the snapshot was not refreshed: the fetch failed: ${untrusted(r.fetchError ?? "unknown error")})`;
}

/** Items grouped major then minor, then refuted, ignored and unmatched triage keys, then the notes. */
export function renderReport(r: AuditReport): string {
	const groups = SEVERITIES.flatMap((s) => section(s === "major" ? "Major" : "Minor", r.items.filter((i) => i.severity === s).map(itemLine)));
	return [
		"Drift report",
		snapshotLine(r),
		...(r.items.length === 0 ? ["", "No drift found."] : groups),
		...section("Refuted by the scout", r.refuted.map((x) => `- ${x.key} — ${untrusted(x.reason)}`)),
		...section("Ignored", r.ignored.map((k) => `- ${k}`)),
		...section("Unmatched triage commands", r.unmatched.map((k) => `- ${untrusted(k)}`)),
		...section("Notes", r.notes.map((n) => `- ${n}`)),
		"",
		DISCLAIMER,
	].join("\n");
}

/** `drift-report.<first 12 of commit>.<base36 ms>`. */
const reportId = (commit: string): string => `${DRIFT_REPORT_KIND}.${commit.slice(0, SHORT_SHA)}.${Date.now().toString(36)}`;

/** The marker comment: the audited commit and the items as data, then the rendered report. */
export function reportComment(r: AuditReport, text: string): string {
	return `${writeMarked(DRIFT_REPORT_KIND, reportId(r.commit), { commit: r.commit, items: r.items, refuted: r.refuted, ignored: r.ignored })}\n\n${text}`;
}

/** Why the report is printed only, or undefined when it can be posted. */
function printOnlyReason(d: ReportDestination): string | undefined {
	if (d.target === undefined) return "no initiative is targeted (pass #T or close an initiative first)";
	if (d.forge === undefined) return "no forge is connected";
	if (!d.writable) return "the forge is read-only";
	return undefined;
}

/** Posts one new `drift-report` comment on the target when possible; always returns the printed text. */
export async function deliverReport(r: AuditReport, d: ReportDestination): Promise<{ text: string; posted?: number }> {
	const text = renderReport(r);
	const reason = printOnlyReason(d);
	if (reason !== undefined || d.forge === undefined || d.target === undefined) return { text: `${text}\n\nPrinted only: ${reason}.` };
	try {
		await d.forge.createComment(d.target, reportComment(r, text));
	} catch (error) {
		return { text: `${text}\n\nPrinted only: the report could not be posted on #${d.target}: ${untrusted(messageOf(error))}.` };
	}
	return { text: `${text}\n\nPosted on #${d.target}.`, posted: d.target };
}
