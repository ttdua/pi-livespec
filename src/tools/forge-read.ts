// `forge_read`: a read-only view of the forge for the main session; refuses in a child session.
// Human-authored text is wrapped as untrusted; only own marked comments are shown as state.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { messageOf } from "../core/messages.ts";
import { type Comment, type Forge, type Issue } from "../forge/types.ts";
import { parseMarked } from "../forge/markers.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { isChildSession } from "../subagents/child.ts";
import { requireSession, type Refusal, type ToolResult, toolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";

export const FORGE_READ_TARGETS = ["issue", "comments", "pr", "pr-files", "reviews", "review-comments", "checks", "search"] as const;
type Target = (typeof FORGE_READ_TARGETS)[number];

export type ForgeReadParams = { target: string; number?: number; ref?: string; labels?: string[]; text?: string };

const CHILD_REFUSAL = "forge_read is not available in a child session: read your packet and its spill files instead.";
const NUMBER_TARGETS: Target[] = ["issue", "comments", "pr", "pr-files", "reviews", "review-comments"];

const isTarget = (v: string): v is Target => (FORGE_READ_TARGETS as readonly string[]).includes(v);
const fail = (message: string): ToolResult<null> => toolResult(message, null, true);

function issueLine(i: Issue): string {
	const url = i.url === undefined ? "" : ` ${i.url}`;
	return `issue:${i.number} version ${i.version} updatedAt ${i.updatedAt} ${i.state} by ${untrusted(i.author)}${url}\n  title: ${untrusted(i.title)}\n  labels: ${i.labels.map(untrusted).join(", ")}`;
}

/** Own marked comments (the current login) are state; everything else, marked or not, is untrusted text. */
function commentBlock(c: Comment, login: string): string {
	const head = `comment:${c.id} version ${c.version} updatedAt ${c.updatedAt}`;
	const marked = c.author === login ? parseMarked(c.body) : null;
	if (marked) return `${head} own marked ${marked.kind}:${marked.id}\n  data: ${JSON.stringify(marked.data)}`;
	return `${head} by ${untrusted(c.author)}\n${untrusted(c.body)}`;
}

type Reader = (forge: Forge, p: ForgeReadParams, n: number) => Promise<string>;

const READERS: Record<Exclude<Target, "checks" | "search">, Reader> = {
	issue: async (f, _p, n) => {
		const i = await f.getIssue(n);
		return `${issueLine(i)}\n  body:\n${untrusted(i.body)}`;
	},
	comments: async (f, _p, n) => {
		const [{ login }, comments] = await Promise.all([f.whoami(), f.listComments(n)]);
		return comments.length === 0 ? "No comments." : comments.map((c) => commentBlock(c, login)).join("\n");
	},
	pr: async (f, _p, n) => {
		const pr = await f.getPullRequest(n);
		return `pr:${pr.number} version ${pr.version} ${pr.state}${pr.merged ? " merged" : ""} head ${untrusted(pr.head)} base ${untrusted(pr.base)}\n  title: ${untrusted(pr.title)}\n  body:\n${untrusted(pr.body)}`;
	},
	"pr-files": async (f, _p, n) => (await f.getPullRequestFiles(n)).map((p) => `- ${untrusted(p)}`).join("\n") || "No files.",
	reviews: async (f, _p, n) => (await f.listReviews(n)).map((r) => `review by ${untrusted(r.author)} ${r.state}\n${untrusted(r.body)}`).join("\n") || "No reviews.",
	"review-comments": async (f, _p, n) =>
		(await f.listReviewComments(n)).map((c) => `${untrusted(c.path)}:${c.line} by ${untrusted(c.author)}\n${untrusted(c.body)}`).join("\n") || "No review comments.",
};

async function readChecks(forge: Forge, ref: string): Promise<string> {
	const summary = await forge.getChecks(ref);
	return [`checks for ${untrusted(ref)}: ${summary.state}`, ...summary.checks.map((c) => `- ${untrusted(c.name)}: ${c.state}`)].join("\n");
}

async function readSearch(forge: Forge, p: ForgeReadParams): Promise<string> {
	const found = await forge.searchIssues({ state: "all", ...(p.labels === undefined ? {} : { labels: p.labels }), ...(p.text === undefined ? {} : { text: p.text }) });
	return found.map((i) => `#${i.number} ${issueLine(i)}`).join("\n") || "No issues.";
}

function refusalOf(p: ForgeReadParams): string | undefined {
	if (!isTarget(p.target)) return `Unknown target ${JSON.stringify(p.target)}. Allowed targets: ${FORGE_READ_TARGETS.join(", ")}.`;
	if (NUMBER_TARGETS.includes(p.target) && !(Number.isInteger(p.number) && (p.number as number) > 0)) return `Target ${p.target} needs a positive integer number.`;
	if (p.target === "checks" && (typeof p.ref !== "string" || p.ref === "")) return "Target checks needs a ref.";
	if (p.target === "search" && p.labels === undefined && p.text === undefined) return "Target search needs labels or text.";
	return undefined;
}

async function readTarget(forge: Forge, p: ForgeReadParams): Promise<string> {
	if (p.target === "checks") return readChecks(forge, p.ref as string);
	if (p.target === "search") return readSearch(forge, p);
	return READERS[p.target as keyof typeof READERS](forge, p, p.number as number);
}

/** The tool body: guards, validation, then one read-only call over the `Forge` interface. */
export async function runForgeRead(p: ForgeReadParams, ctx: Parameters<typeof isChildSession>[0]): Promise<ToolResult<null>> {
	if (isChildSession(ctx)) return fail(CHILD_REFUSAL);
	const s = requireSession();
	if (!s.ok) return fail((s as Refusal).message);
	const refusal = refusalOf(p);
	if (refusal) return fail(refusal);
	const forge = s.session.forge;
	if (!forge) return fail("No forge is connected.");
	try {
		return toolResult(await readTarget(forge, p), null);
	} catch (error) {
		return fail(`forge_read failed: ${untrusted(messageOf(error))}`);
	}
}

export function registerForgeRead(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: "forge_read",
		label: "Read the forge",
		description: `Read-only forge access. target is one of: ${FORGE_READ_TARGETS.join(", ")}. Human text comes back wrapped as <untrusted>.`,
		parameters: {
			type: "object",
			properties: {
				target: { type: "string", description: `One of: ${FORGE_READ_TARGETS.join(", ")}` },
				number: { type: "number", description: "Issue or pull request number" },
				ref: { type: "string", description: "Git ref for checks" },
				labels: { type: "array", items: { type: "string" } },
				text: { type: "string" },
			},
			required: ["target"],
		} as never,
		execute: (_id, params, _signal, _update, ctx) => runForgeRead(params as ForgeReadParams, ctx as never),
	});
}
