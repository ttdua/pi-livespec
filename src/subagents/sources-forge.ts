// Providers that read the forge: referenced issues, pull request review comments and checks, closed changes.

import { matchGlob } from "../core/glob.ts";
import { parseChange } from "../core/change.ts";
import { parseSpec } from "../core/spec.ts";
import type { Issue, PullRequest } from "../forge/types.ts";
import { declaredCapabilities, numberOf, placed, prNumber, readText, sha256, type Cx, type Provider } from "./source-kit.ts";
import { unitText } from "./sources-change.ts";
import type { Placed } from "./source-types.ts";

const ISSUE_REF = /(?:^|[^\w&])#(\d+)\b/g;
/** Closed pull requests a scout reads: the highest-numbered ones, a search bound stated in the packet (`PullRequest` has no close time). */
const MAX_CLOSED_PRS = 30;

export const SCOUT_SCOPE = `Search scope: closed issues of the same capability, and the ${MAX_CLOSED_PRS} highest-numbered closed pull requests that touched the capability's \`paths\`; lower-numbered pull requests were not searched.`;

/** `issue#<n>` for every `#N` the unit text names, one hop; the change's own issue and initiative are skipped. */
export const referencedIssues: Provider = {
	name: "referenced-issues",
	async run(cx) {
		const unit = cx.target.unit;
		if (!unit) return [];
		const own = new Set([cx.ctx.state.issue.number, numberOf(cx.ctx.state.change.header.initiative)]);
		const refs = [...new Set([...unitText(cx, unit).matchAll(ISSUE_REF)].map((m) => Number(m[1])))].filter((n) => !own.has(n));
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

/** Closed `livespec` issues of the same capability. */
async function closedIssues(cx: Cx): Promise<Issue[]> {
	const caps = new Set(declaredCapabilities(cx.ctx.state.change));
	const closed = await cx.ctx.forge.searchIssues({ state: "closed", labels: ["livespec"] });
	return closed.filter((i) => i.number !== cx.ctx.state.issue.number && declaredCapabilities(parseChange(i.body)).some((c) => caps.has(c)));
}

/** The `paths` globs of the declared capabilities' living specs; a capability without a spec contributes none. */
async function capabilityPaths(cx: Cx): Promise<string[]> {
	const out: string[] = [];
	for (const cap of declaredCapabilities(cx.ctx.state.change)) {
		const text = await readText(cx.ctx.root, `specs/${cap}/spec.md`);
		if (text !== undefined) out.push(...parseSpec(text, cap).paths);
	}
	return out;
}

/** The highest-numbered closed pull requests, merged or not, that changed a file matching one of the capability `paths`. */
async function closedPullRequests(cx: Cx): Promise<PullRequest[]> {
	const globs = await capabilityPaths(cx);
	if (globs.length === 0) return [];
	const recent = (await cx.ctx.forge.listPullRequests({ state: "closed" }))
		.filter((p) => p.number !== prNumber(cx.ctx.state.change))
		.sort((a, b) => b.number - a.number)
		.slice(0, MAX_CLOSED_PRS);
	const hits: PullRequest[] = [];
	for (const pr of recent) {
		const files = await cx.ctx.forge.getPullRequestFiles(pr.number);
		if (files.some((f) => globs.some((g) => g === f || matchGlob(g, f)))) hits.push(pr);
	}
	return hits;
}

/** Closed issues of the same capability and closed pull requests touching the same `paths`; scouts read them. */
export const closedWork: Provider = {
	name: "closed-work",
	async run(cx) {
		const issues = (await closedIssues(cx)).map((i) => placed({ id: `issue#${i.number}`, version: i.updatedAt, title: `Closed change #${i.number}: ${i.title}`, text: i.body, untrusted: true }));
		const prs = (await closedPullRequests(cx)).map((p) => placed({ id: `pr#${p.number}`, version: p.version, title: `Closed pull request #${p.number}: ${p.title}`, text: p.body, untrusted: true }));
		return [...issues, ...prs];
	},
};

/**
 * The last comment of each closed change of the same capability. No closing-summary marker exists yet (change closure
 * is defined later), so the last comment stands in, titled as such.
 */
export const closingSummaries: Provider = {
	name: "closing-summaries",
	async run(cx) {
		const out: Placed[] = [];
		for (const issue of await closedIssues(cx)) {
			const last = (await cx.reads.comments(issue.number)).at(-1);
			if (last) out.push(placed({ id: `comment:${last.id}`, version: last.updatedAt, title: `Closing summary of #${issue.number}: last comment (closing summary not yet defined)`, text: last.body, untrusted: true }));
		}
		return out;
	},
};
