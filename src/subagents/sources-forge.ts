// Providers that read the forge: referenced issues, pull request review comments and checks, closed changes.

import { matchGlob } from "../core/glob.ts";
import { parseChange } from "../core/change.ts";
import { declaredCapabilities, numberOf, placed, prNumber, sha256, type Provider } from "./source-kit.ts";
import { unitText } from "./sources-change.ts";
import type { Placed } from "./source-types.ts";

const ISSUE_REF = /(?:^|[^\w&])#(\d+)\b/g;
const MAX_REFS = 10;

/** `issue#<n>` for every `#N` the unit text names, one hop; the change's own issue and initiative are skipped. */
export const referencedIssues: Provider = {
	name: "referenced-issues",
	async run(cx) {
		const unit = cx.target.unit;
		if (!unit) return [];
		const own = new Set([cx.ctx.state.issue.number, numberOf(cx.ctx.state.change.header.initiative)]);
		const refs = [...new Set([...unitText(cx, unit).matchAll(ISSUE_REF)].map((m) => Number(m[1])))].filter((n) => !own.has(n)).slice(0, MAX_REFS);
		const out: Placed[] = [];
		for (const n of refs) {
			const issue = await cx.reads.issue(n);
			out.push(placed({ id: `issue#${n}`, version: issue.updatedAt, title: `Referenced issue #${n}: ${issue.title}`, text: issue.body, untrusted: true }));
		}
		return out;
	},
};

const reviewId = (c: { path: string; line: number; body: string }): string => sha256(`${c.path}:${c.line}:${c.body}`).slice(0, 12);

/** `review:<id>` for the pull request's review comments, all of them or only those on `files`. */
export function reviewComments(onUnitFiles: boolean): Provider {
	return {
		name: "review-comments",
		async run(cx) {
			const pr = prNumber(cx.ctx.state.change);
			if (pr === undefined) return [];
			const files = cx.target.unit?.files ?? [];
			const all = await cx.ctx.forge.listReviewComments(pr);
			const chosen = onUnitFiles ? all.filter((c) => files.some((f) => f === c.path || matchGlob(f, c.path))) : all;
			return chosen.map((c) => placed({ id: `review:${reviewId(c)}`, version: sha256(c.body), title: `Review comment on ${c.path}:${c.line} by ${c.author}`, text: c.body, untrusted: true }));
		},
	};
}

/** `pr#<n>` and `check:<sha>:<name>` once a pull request exists. */
export const pullRequestAndChecks: Provider = {
	name: "pull-request",
	async run(cx) {
		const pr = prNumber(cx.ctx.state.change);
		if (pr === undefined) return [];
		const [request, checks] = await Promise.all([cx.ctx.forge.getPullRequest(pr), cx.ctx.forge.getChecks(cx.ctx.state.git.head)]);
		const out = [placed({ id: `pr#${pr}`, version: request.version, title: `Pull request #${pr}: ${request.title}`, text: request.body, untrusted: true })];
		for (const c of checks.checks) {
			out.push(placed({ id: `check:${cx.ctx.state.git.head}:${c.name}`, version: c.state, title: `Check ${c.name}`, text: `${c.name}: ${c.state}${c.url ? ` ${c.url}` : ""}`, untrusted: true }));
		}
		return out;
	},
};

/** Closed `livespec` issues of the same capability or touching the same `paths`; scouts read their titles. */
export const closedWork: Provider = {
	name: "closed-work",
	async run(cx) {
		const caps = new Set(declaredCapabilities(cx.ctx.state.change));
		const closed = await cx.ctx.forge.searchIssues({ state: "closed", labels: ["livespec"] });
		return closed
			.filter((i) => i.number !== cx.ctx.state.issue.number && declaredCapabilities(parseChange(i.body)).some((c) => caps.has(c)))
			.map((i) => placed({ id: `issue#${i.number}`, version: i.updatedAt, title: `Closed change #${i.number}: ${i.title}`, text: i.body, untrusted: true }));
	},
};

/** The last comment of each closed change of the same capability: its closing summary. */
export const closingSummaries: Provider = {
	name: "closing-summaries",
	async run(cx) {
		const out: Placed[] = [];
		for (const issue of (await closedWork.run(cx)).map((p) => numberOf(p.source.id) as number)) {
			const last = (await cx.reads.comments(issue)).at(-1);
			if (last) out.push(placed({ id: `comment:${last.id}`, version: last.updatedAt, title: `Closing summary of #${issue}`, text: last.body, untrusted: true }));
		}
		return out;
	},
};
