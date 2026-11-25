// Shared fixture of the ship-phase tool tests: a change in `ship` on its branch with the review and ship gates at HEAD.

import { gateDigest } from "../../src/engine/locks.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import type { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import type { FakeUI } from "../hooks/fake-pi.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { originRefs, type ToolHarness, toolHarness } from "./helpers.ts";

export const AT = "2026-11-15T10:00:00.000Z";
export const FORGE_CHAIN = "integrationBranch: main\ninteraction: { adapter: [forge] }\n";

const BODY = [
	"Depends: —",
	"Capabilities: new [], modified []",
	"Product impact: none — test fixture",
	"",
	"## Proposal",
	"Limit each client IP. Closes #12.",
	"",
	"## Design",
	"Counter.",
	"",
	"## Questions",
	"",
	"## Units",
	"### U1 — Limit",
	"Covers: rate-limit/Requirement: Per-IP cap",
	"Difficulty: low",
	"Tags: []",
	"Files: src/limit.ts",
	"Done means:",
	"- [cap] capped",
	"Scenarios:",
	"- [cap] test/limit.test.ts › caps",
	"Depends: —",
	"Verify: `true`",
	"- [x] done",
	"",
	"## Durable docs",
	"",
].join("\n");

export type Opts = { branch?: string; config?: string; ui?: FakeUI; forge?: (world: MemoryWorld) => Forge; body?: (b: string) => string; noShipGate?: boolean; files?: Record<string, string> };

export const gateComment = (phase: string, id: string, head: string, extra: Record<string, unknown> = {}): string =>
	writeMarked("gate", `${phase}.${id}`, { phase, outcome: "approved", notes: "", by: "alice", at: AT, adapter: "forge", head_sha: head, waivers: [], ...extra });

/** Posts an approved ship gate at `head` with its request record, as a forge approval leaves them. */
export async function approveShip(h: ToolHarness, id: string, head = h.git("rev-parse", "HEAD")): Promise<void> {
	const requestId = `gate-ship.${id}`;
	const digest = gateDigest(await h.world.bodyOf(h.n));
	await h.world.postComment(h.n, BOT_LOGIN, writeMarked("request", requestId, { kind: "gate", subject: "gate:ship", mode: "blocking", head_sha: head, gate_digest: digest, snapshot: {}, summary: "s" }));
	await h.world.postComment(h.n, BOT_LOGIN, gateComment("ship", requestId, head, { request: requestId }));
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
}

/**
 * A change in `ship` on its branch with one committed unit file, the review gate at HEAD and (by default) an
 * approved ship gate at HEAD. The issue is seeded after the commit, so no refresh sees it unreviewed.
 */
export async function shipReady(o: Opts = {}): Promise<ToolHarness> {
	const branch = o.branch ?? "livespec/per-ip-cap";
	const base = await toolHarness({ branch, ...(o.ui ? { ui: o.ui } : {}), ...(o.config ? { config: o.config } : {}), ...(o.forge ? { forge: o.forge } : {}), ...(o.files ? { files: o.files } : {}) });
	await writeIn(base.root, "src/limit.ts", "export const cap = 100;\n");
	commitAll(base.root, "limit");
	const head = base.git("rev-parse", "HEAD");
	const body = `Base: ${base.head}\nBranch: ${branch}\n${(o.body ?? ((b: string) => b))(BODY)}`;
	const n = await base.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", "livespec:phase/ship"] });
	const h = { ...base, n };
	await h.world.postComment(h.n, BOT_LOGIN, gateComment("review", "self-1", head));
	if (o.noShipGate) {
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
	} else {
		await approveShip(h, "a1", head);
	}
	return h;
}

export async function marked(h: ToolHarness): Promise<MarkedComment[]> {
	return filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
}

export const ofKind = async (h: ToolHarness, kind: string) => (await marked(h)).filter((m) => m.kind === kind);
export const openPulls = (h: ToolHarness) => h.world.forge.listPullRequests({ state: "open" });
export const branchOf = (h: ToolHarness) => h.git("branch", "--show-current");
export const pushed = (h: ToolHarness) => originRefs(h.origin).includes(`refs/heads/${branchOf(h)}`);

