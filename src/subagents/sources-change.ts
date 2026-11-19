// Providers that read the change issue body: covered requirements, answered questions and issue sections.

import { joinLines } from "../core/lines.ts";
import type { Unit } from "../core/change.ts";
import { parseSpec } from "../core/spec.ts";
import { numberOf, placed, readText, sectionText, sha256, type Cx, type Provider } from "./source-kit.ts";
import type { Placed } from "./source-types.ts";

const COVERS = /^(.+?)\/Requirement:\s*(.+)$/;

/** The unit's block of the issue body, verbatim. */
export const unitText = (cx: Cx, unit: Unit): string => joinLines(cx.ctx.state.change.lines.slice(unit.startLine, unit.endLine + 1));

/** The requirement blocks of `spec` named in `names`, as written in the spec file. */
function requirementBlocks(text: string, capability: string, names: Set<string>): string {
	const spec = parseSpec(text, capability);
	const lines = spec.lines.map((l) => l.text);
	return spec.requirements
		.map((rq, i) => ({ rq, end: (spec.requirements[i + 1]?.line ?? lines.length + 1) - 1 }))
		.filter(({ rq }) => names.has(rq.name))
		.map(({ rq, end }) => {
			const stop = lines.findIndex((t, at) => at >= rq.line && t.startsWith("## "));
			return lines.slice(rq.line - 1, stop === -1 ? end : Math.min(end, stop)).join("\n").trim();
		})
		.join("\n\n");
}

/** `spec:<capability>` per capability the unit covers, with only the covered requirements; pinned inline. */
export const coveredRequirements: Provider = {
	name: "covered-requirements",
	async run({ ctx, target }) {
		const byCap = new Map<string, Set<string>>();
		for (const cover of target.unit?.covers ?? []) {
			const m = COVERS.exec(cover);
			if (m) byCap.set(m[1] as string, (byCap.get(m[1] as string) ?? new Set()).add((m[2] as string).trim()));
		}
		const out: Placed[] = [];
		for (const [cap, names] of byCap) {
			const text = await readText(ctx.root, `specs/${cap}/spec.md`);
			if (text === undefined) continue;
			const body = requirementBlocks(text, cap, names);
			if (body !== "") out.push(placed({ id: `spec:${cap}`, version: sha256(body), title: `Covered requirements of ${cap}`, text: body, untrusted: false }, "pinned"));
		}
		return out;
	},
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `haystack` names the unit id, a covered requirement or one of the unit's `Files`. */
function mentions(haystack: string, unit: Unit): boolean {
	const requirements = unit.covers.map((c) => COVERS.exec(c)?.[2]?.trim()).filter((r): r is string => r !== undefined && r !== "");
	if (new RegExp(`\\b${escapeRe(unit.id)}\\b`).test(haystack)) return true;
	return [...requirements, ...unit.files].some((needle) => haystack.includes(needle));
}

/** Answered questions of the body: only those that mention the unit for an implementer, all of them otherwise. */
export function answeredQuestions(all: boolean): Provider {
	return {
		name: "answered-questions",
		async run({ ctx, target }) {
			const out: Placed[] = [];
			for (const q of ctx.state.change.questions) {
				if (q.answer === undefined || (!all && !(target.unit && mentions(`${q.text} ${q.answer}`, target.unit)))) continue;
				const text = `${q.id} (${q.kind}): ${q.text}\nAnswer: ${q.answer}`;
				out.push(placed({ id: `answer:${q.id}`, version: sha256(text), title: `Answered question ${q.id}`, text, untrusted: true }));
			}
			return out;
		},
	};
}

/** `issue#<n>` of the change issue: the whole body, the header only, or the `Units` section. */
export function changeIssue(part: "body" | "header" | "units"): Provider {
	return {
		name: "change-issue",
		async run({ ctx, reads }) {
			const issue = await reads.issue(ctx.state.issue.number);
			const text = part === "body" ? issue.body : part === "header" ? sectionText(ctx.state.change, "") : sectionText(ctx.state.change, "Units");
			return [placed({ id: `issue#${issue.number}`, version: issue.updatedAt, title: `Change issue #${issue.number}: ${issue.title}`, text, untrusted: true })];
		},
	};
}

/** `issue#<n>` of the initiative named in the header. */
export const initiativeIssue: Provider = {
	name: "initiative",
	async run({ ctx, reads }) {
		const n = numberOf(ctx.state.change.header.initiative);
		if (n === undefined) return [];
		const issue = await reads.issue(n);
		return [placed({ id: `issue#${n}`, version: issue.updatedAt, title: `Initiative #${n}: ${issue.title}`, text: issue.body, untrusted: true })];
	},
};
