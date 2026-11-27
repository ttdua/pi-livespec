// Providers over the change's own marked comments: gate notes, findings, receipts, dispatch records and decisions.

import { stringify } from "yaml";
import type { ReceiptRecord } from "../evidence/records.ts";
import type { MarkedComment } from "../forge/markers.ts";
import { latestDispatch, type DispatchData, type DispatchQuestionData } from "./records.ts";
import { placed, sha256, type Cx, type Provider } from "./source-kit.ts";
import type { Placed } from "./source-types.ts";


/** The comment's updated-at, the version of a `comment:<id>` source; falls back to a content hash. */
async function commentVersion(cx: Cx, m: MarkedComment): Promise<string> {
	const found = (await cx.reads.comments(cx.ctx.state.issue.number)).find((c) => c.id === m.commentId);
	return found?.updatedAt ?? sha256(JSON.stringify(m.data));
}

/**
 * Every caller's text holds free text a human (gate notes, decisions) or a child (notes, discoveries, findings) wrote,
 * so the whole source is wrapped: an injection in one child's record must not reach the next packet as state.
 */
async function commentSource(cx: Cx, m: MarkedComment, title: string, text: string): Promise<Placed> {
	return placed({ id: `comment:${m.commentId}`, version: await commentVersion(cx, m), title, text, untrusted: true });
}

/** Notes humans gave at the plan gate. */
export const planGateNotes: Provider = {
	name: "plan-gate-notes",
	async run(cx) {
		const out: Placed[] = [];
		for (const m of cx.ctx.state.marked) {
			const d = m.data as { notes?: unknown; phase?: unknown } | null;
			if (m.kind !== "gate" || d?.phase !== "plan" || typeof d.notes !== "string" || d.notes.trim() === "") continue;
			out.push(await commentSource(cx, m, "Plan gate notes", d.notes));
		}
		return out;
	},
};

type SummaryShape = { unit?: unknown; findings?: unknown; role?: unknown; aggregate?: unknown } | null;

/** The findings of `m` that concern `unit`: a unit review's findings, or an aggregate's findings routed to the unit. */
function findingsFor(m: MarkedComment, unit: string | undefined): unknown[] {
	const d = m.data as SummaryShape;
	if (m.kind !== "finding-summary" || !d || d.role === "verifier" || !Array.isArray(d.findings)) return [];
	if (d.aggregate === true) return unit === undefined ? [] : d.findings.filter((f) => (f as { routeUnit?: unknown } | null)?.routeUnit === unit);
	return d.unit === unit ? d.findings : [];
}

/** Earlier non-empty finding summaries of the unit, and aggregate review findings routed to it. */
export const unitFindings: Provider = {
	name: "unit-findings",
	async run(cx) {
		const unit = cx.target.unit?.id;
		const out: Placed[] = [];
		for (const m of cx.ctx.state.marked) {
			const findings = findingsFor(m, unit);
			if (findings.length > 0) out.push(await commentSource(cx, m, `Earlier findings on ${unit}`, stringify(findings)));
		}
		return out;
	},
};

/** One receipt in full: both SHAs and exits and the whole output. */
export const receiptText = (unit: string, receipt: ReceiptRecord): string =>
	`Receipt of ${unit}: pre ${receipt.pre.sha} exit ${receipt.pre.exit}, post ${receipt.post.sha} exit ${receipt.post.exit}\n${receipt.output}`;

function receiptSource(cx: Cx, unit: string): Placed | undefined {
	const receipt = cx.ctx.state.evidence.receipts[unit]?.at(-1);
	if (!receipt) return undefined;
	const text = receiptText(unit, receipt);
	return placed({ id: `receipt:${unit}`, version: sha256(text), title: `Receipt of ${unit}`, text, untrusted: true });
}

async function dispatchSource(cx: Cx, unit: string): Promise<Placed | undefined> {
	const data: DispatchData | undefined = latestDispatch(cx.ctx.state.marked, unit);
	const m = data === undefined ? undefined : cx.ctx.state.marked.find((c) => c.data === data);
	if (!data || !m) return undefined;
	const text = [
		`Status: ${data.status}`,
		`Commits: ${data.commits.length === 0 ? "none" : data.commits.join(", ")}`,
		`Notes: ${data.notes}`,
		...data.discoveries.map((d) => `Discovery: ${d}`),
		`Sources used: ${data.sources_used.length === 0 ? "none" : data.sources_used.join(", ")}`,
	].join("\n");
	return commentSource(cx, m, `Dispatch record of ${unit}`, text);
}

/** Receipts and latest dispatch records of the units the target unit depends on. */
export const dependencyRecords: Provider = {
	name: "dependency-records",
	async run(cx) {
		const out: Placed[] = [];
		for (const dep of cx.target.unit?.depends ?? []) {
			const receipt = receiptSource(cx, dep);
			if (receipt) out.push(receipt);
			const dispatch = await dispatchSource(cx, dep);
			if (dispatch) out.push(dispatch);
		}
		return out;
	},
};

/** The receipt of every unit that has one. */
export const allReceipts: Provider = {
	name: "receipts",
	async run(cx) {
		return Object.keys(cx.ctx.state.evidence.receipts).flatMap((unit) => {
			const found = receiptSource(cx, unit);
			return found ? [found] : [];
		});
	},
};

/** The receipt of one named unit. */
export function receiptsOf(unit: string | undefined): Provider {
	return {
		name: "unit-receipts",
		run: async (cx) => {
			const found = unit === undefined ? undefined : receiptSource(cx, unit);
			return found ? [found] : [];
		},
	};
}

/** `decision` records, as kept state. */
export const decisionRecords: Provider = {
	name: "decisions",
	async run(cx) {
		const out: Placed[] = [];
		for (const m of cx.ctx.state.marked.filter((c) => c.kind === "decision")) out.push(await commentSource(cx, m, `Decision ${m.id}`, stringify(m.data)));
		return out;
	},
};

/** Answers the parent gave to a child's question: `answer:<agentId>:<n>`. */
export function dispatchAnswers(all: boolean): Provider {
	return {
		name: "dispatch-answers",
		async run(cx) {
			const unit = cx.target.unit?.id;
			const seen = new Map<string, number>();
			const out: Placed[] = [];
			for (const m of cx.ctx.state.marked) {
				const d = m.data as Partial<DispatchQuestionData> | null;
				if (m.kind !== "dispatch" || d?.status !== "ANSWERED" || typeof d.agentId !== "string" || typeof d.answer !== "string") continue;
				if (!all && d.unit !== unit) continue;
				const n = (seen.get(d.agentId) ?? 0) + 1;
				seen.set(d.agentId, n);
				out.push(placed({ id: `answer:${d.agentId}:${n}`, version: sha256(d.answer), title: `Answer to the ${d.role} child`, text: d.answer, untrusted: true }));
			}
			return out;
		},
	};
}

/** A leading `#` on any line becomes `\#`, so record text cannot pass for a source section or an inner `#### <id>` line. */
const escapeHeadings = (text: string): string => text.replace(/^#/gm, "\\#");

/** Folds the sources of `provider` into one optional, untrusted source `records:<kind>`; none when it yields none. */
export function grouped(kind: string, title: string, provider: Provider): Provider {
	const id = `records:${kind}`;
	return {
		name: id,
		async run(cx) {
			const inner = await provider.run(cx);
			if (inner.length === 0) return [];
			const text = inner.map((p) => `#### ${p.source.id}\n${escapeHeadings(p.source.text)}`).join("\n\n");
			return [placed({ id, version: sha256(text), title, text, untrusted: true, required: false })];
		},
	};
}
