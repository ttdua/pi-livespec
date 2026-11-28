import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TEMPLATE_MARKER } from "../../src/core/templates.ts";
import { gateMemoGeneration, onGateMemoClear } from "../../src/engine/registry.ts";
import { withEvidenceLock } from "../../src/evidence/lock.ts";
import { getSession, setSession } from "../../src/hooks/session-store.ts";
import { gitStatus } from "../helpers/repo.ts";
import { asChild } from "./fake-pi.ts";
import { allDone, BUILD_LABELS, CHANGE_BRANCH, cardText, cleanupHomes, contextCall, harness, type Msg, resumeBody, TREE_SHA } from "./helpers.ts";
import { writeIn } from "../helpers/repo.ts";
import { execFileSync } from "node:child_process";
import type { Forge } from "../../src/forge/types.ts";
import type { MemoryWorld } from "../forge/memory-forge.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupHomes();
});

/** The resume cards shown at session start: UI-only entries, as `{ content }` for the assertions below. */
const resumeMessages = (entries: { customType: string; data: unknown }[]) =>
	entries.filter((e) => e.customType === "livespec-resume").map((e) => ({ content: (e.data as { text: string }).text }));

describe("session_start", () => {
	test("Resume mid-change", async () => {
		const h = await harness({ branch: CHANGE_BRANCH });
		const n = await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.start();
		const [resume] = resumeMessages(h.pi.entries);
		expect(resume?.content).toContain(`#${n}`);
		expect(resume?.content).toContain("· build");
		expect(resume?.content).toContain("Next: <untrusted>Build U3 — Rate limit per IP.</untrusted>");
		expect(resume?.content).toContain("Read specs/product.md");
		expect(await cardText(h.pi, h.ctx)).toContain("Next: <untrusted>Build U3 — Rate limit per IP.</untrusted>");
	});

	test("Other branch", async () => {
		const h = await harness();
		const a = await h.world.seedIssue({ title: "rate-limit", labels: BUILD_LABELS });
		const b = await h.world.seedIssue({ title: "audit-log", labels: ["livespec", "livespec:phase/define"] });
		await h.start();
		const [resume] = resumeMessages(h.pi.entries);
		expect(resume?.content).toContain(`#${a} <untrusted>rate-limit</untrusted> (build)`);
		expect(resume?.content).toContain(`#${b} <untrusted>audit-log</untrusted> (define)`);
	});

	test("Fix branch", async () => {
		const h = await harness({ branch: "fix/typo" });
		await h.world.seedIssue({ title: "rate-limit", labels: BUILD_LABELS });
		await h.world.seedIssue({ title: "audit-log", labels: ["livespec", "livespec:phase/define"] });
		await h.start();
		const [resume] = resumeMessages(h.pi.entries);
		expect(resume?.content).toContain("livespec · fix/typo");
		expect(resume?.content).not.toContain("rate-limit");
		expect(resume?.content).not.toContain("audit-log");
		expect(resume?.content).not.toContain("Open changes");
		expect(resume?.content).not.toMatch(/subagent_(dispatch|packet)/);
	});

	test("Forge unavailable", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, detectFails: true });
		await expect(h.start()).resolves.toBeUndefined();
		const [resume] = resumeMessages(h.pi.entries);
		expect(resume?.content).toContain("livespec · forge unavailable");
		expect(resume?.content).toContain("unknown forge host");
		expect(await cardText(h.pi, h.ctx)).toContain("livespec · forge unavailable");
		expect(getSession()?.forge).toBeUndefined();
		expect(getSession()?.errors.join("\n")).toContain("unknown forge host");
	});

	test("Plain project", async () => {
		const h = await harness({ initialized: false });
		await h.start();
		expect(h.pi.sent).toEqual([]);
		expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);
		const [message] = h.ctx.ui.notify.mock.calls[0] as [string];
		expect(message).toContain("/livespec init");
		expect(message).not.toContain("migrate-openspec");
		const prompt = { type: "before_agent_start", systemPromptOptions: { sections: {} as Record<string, string> } };
		await h.pi.fire("before_agent_start", prompt, h.ctx);
		expect(prompt.systemPromptOptions.sections).toEqual({});
		expect(await h.pi.fire("context", { type: "context", messages: [] }, h.ctx)).toBeUndefined();
		expect(h.content.autoCheck.calls).toHaveLength(0);
	});

	test("OpenSpec project", async () => {
		const h = await harness({ initialized: false, files: { "openspec/specs/a/spec.md": "# a\n" } });
		const before = gitStatus(h.root);
		await h.start();
		expect(h.pi.sent).toEqual([]);
		expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);
		const [message] = h.ctx.ui.notify.mock.calls[0] as [string];
		expect(message).toContain("/livespec migrate-openspec");
		expect(message).toContain("/livespec init");
		expect(gitStatus(h.root)).toEqual(before);
	});

	test("Build complete", async () => {
		const h = await harness({ branch: CHANGE_BRANCH });
		const n = await h.world.seedIssue({ title: "per-ip-cap", body: allDone(resumeBody(h.head)), labels: BUILD_LABELS });
		await h.start();
		const issue = await h.world.forge.getIssue(n);
		expect(issue.labels).toContain("livespec:phase/review");
		expect(issue.labels).not.toContain("livespec:phase/build");
		// I1: the start card is built from the local ledger and never advances; the advance follows the fetch.
		expect(resumeMessages(h.pi.entries)[0]?.content).toContain("· build");
	});

	test("Not blocking", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, activeTree: `/clone/${TREE_SHA}` });
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		let settled = false;
		void h.content.autoCheck.outcome.promise.then(() => (settled = true));
		await h.start();
		await vi.waitFor(() => expect(h.content.autoCheck.calls).toHaveLength(1), { timeout: 10_000 });
		expect(settled).toBe(false);
		h.content.autoCheck.outcome.resolve({ kind: "installed", sha: "b".repeat(40), changed: { added: [], removed: [], changed: ["interview-me"] } });
		await getSession()?.upgrade;
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interview-me"), "info");
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/reload"), "info");
	});

	test("session exposes pack errors for an invalid override", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, files: { ".pi/livespec/flow.yaml": "extends: agent-skills\nphases: {}\n" } });
		await h.start();
		const session = getSession();
		expect(session?.pack.ok).toBe(false);
		expect(session?.card.kind).toBe("pack-errors");
		expect(resumeMessages(h.pi.entries)[0]?.content).toMatch(/flow\.yaml:2:\d+ phases/);
		expect(h.content.autoCheck.calls).toHaveLength(0);
	});

	test("a pack load that throws shows the reason on the card", async () => {
		// The override path is a directory, so reading it fails with EISDIR and loadPack throws.
		const h = await harness({ branch: CHANGE_BRANCH, files: { ".pi/livespec/flow.yaml/keep": "x\n" } });
		await h.start();
		const session = getSession();
		expect(session?.pack).toMatchObject({ ok: false, errors: [{ severity: "error", file: "src/packs/agent-skills.yaml", line: 1, col: 1 }] });
		const card = await cardText(h.pi, h.ctx);
		expect(card).toContain("src/packs/agent-skills.yaml:1:1");
		expect(card).toContain("EISDIR");
	});

	test("session_start kicks off autoCheck without awaiting it", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, activeTree: `/clone/${TREE_SHA}` });
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.start();
		await vi.waitFor(() => expect(h.content.autoCheck.calls).toHaveLength(1), { timeout: 10_000 });
		const [pack, channel, wip] = h.content.autoCheck.calls[0] ?? [];
		expect((pack as { name: string }).name).toBe("agent-skills");
		expect(channel).toBe("auto");
		expect(wip).toMatchObject({ busy: true });
		h.content.autoCheck.outcome.resolve({ kind: "failed", reason: "incompatible", failures: [{ item: "skills/x", reason: "bad" }] });
		await getSession()?.upgrade;
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("skills/x"), "warning");
	});

	test("a rejected upgrade check is notified, never thrown", async () => {
		const h = await harness({ branch: CHANGE_BRANCH });
		const failing = h.content.manager as unknown as { autoCheck: () => Promise<never> };
		failing.autoCheck = () => Promise.reject(new Error("disk full"));
		await h.start();
		await getSession()?.upgrade;
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("disk full"), "warning");
	});

	test("two issues claiming the branch show a change-error card", async () => {
		const h = await harness({ branch: CHANGE_BRANCH });
		await h.world.seedIssue({ title: "a", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.world.seedIssue({ title: "b", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.start();
		const content = resumeMessages(h.pi.entries)[0]?.content ?? "";
		expect(content).toContain("livespec · change not resolved");
		expect(content).toContain("Several open changes match");
		expect(content).not.toContain("Open changes");
	});

	test("resume card is UI-only and never persisted into the LLM context", async () => {
		const h = await harness({ branch: CHANGE_BRANCH });
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.start();
		expect(resumeMessages(h.pi.entries)).toHaveLength(1);
		expect(h.pi.entryRenderers.has("livespec-resume")).toBe(true);
		const rendered = h.pi.entryRenderers.get("livespec-resume")?.(h.pi.entries[0], { expanded: false }, { fg: (_c: string, t: string) => t }) as {
			render(width: number): string[];
		};
		expect(rendered.render(200).join("\n")).toContain("Build U3");
		// What pi would persist: every sendMessage, then the user prompts and replies of two turns.
		const persisted: Msg[] = h.pi.sent.map((m) => ({ role: "custom", customType: m.customType, content: m.content, timestamp: 1 }));
		const isCard = (m: Msg) => typeof m.content === "string" && m.content.startsWith("livespec ·");
		expect(persisted.some(isCard)).toBe(false);
		for (const turn of [1, 2]) {
			persisted.push({ role: "user", content: `prompt ${turn}`, timestamp: turn });
			const out = (await contextCall(h.pi, h.ctx, persisted)) ?? [];
			expect(out.filter(isCard)).toHaveLength(1);
			expect(out.at(-1)?.customType).toBe("livespec-phase-card");
			persisted.push({ role: "assistant", content: [{ type: "text", text: `reply ${turn}` }] });
		}
	});

	test("forge unavailable skips the upgrade check with a recorded reason", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, detectFails: true });
		await h.start();
		await getSession()?.upgrade;
		expect(h.content.autoCheck.calls).toHaveLength(0);
		expect(getSession()?.errors).toContain("agent-skills: forge unavailable; work in progress unknown");
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("forge unavailable; work in progress unknown"), "info");
	});

	test("constraints template prompt follows the real specs/constraints.md", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, files: { "specs/constraints.md": `${TEMPLATE_MARKER}\n# Constraints\n` } });
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.start();
		expect(await cardText(h.pi, h.ctx)).toContain("draft it with the constraint-driven-development skill");
		await writeIn(h.root, "specs/constraints.md", "# Constraints\n- Node 22 only\n");
		await getSession()?.refresh();
		const card = await cardText(h.pi, h.ctx);
		expect(card).not.toContain("constraint-driven-development");
		expect(card).not.toContain("constraints.md");
	});
});

describe("resume entry renderer", () => {
	test("rendered lines fit the viewport for CJK, emoji and tabs", async () => {
		const { FakePi } = await import("./fake-pi.ts");
		const { registerResumeRenderer } = await import("../../src/hooks/resume-entry.ts");
		const pi = new FakePi();
		registerResumeRenderer(pi.api as never);
		const text = "livespec · #7 <untrusted>速率限制每个客户端的请求数量</untrusted>\n🚀🚀🚀🚀🚀🚀🚀 emoji\n\tindented\twith\ttabs and more words";
		const render = pi.entryRenderers.get("livespec-resume")?.({ type: "custom", customType: "livespec-resume", data: { text } }, { expanded: false }, {}) as {
			render(width: number): string[];
		};
		for (const width of [10, 40]) {
			const lines = render.render(width);
			expect(lines.length).toBeGreaterThan(1);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("gate memo scope", () => {
	test("session_start and session_shutdown clear the gate memo", async () => {
		const h = await harness({ branch: CHANGE_BRANCH });
		const before = gateMemoGeneration();
		await h.start();
		expect(gateMemoGeneration()).toBeGreaterThan(before);
		const started = gateMemoGeneration();
		await h.pi.fire("session_shutdown", {}, h.ctx);
		expect(gateMemoGeneration()).toBeGreaterThan(started);
	});
});

describe("gate memo clearing is inside the error boundary", () => {
	let failing = false;
	onGateMemoClear(() => {
		if (failing) throw new Error("listener failed");
	});
	afterEach(() => {
		failing = false;
	});

	test("a throwing clear listener does not reject either hook and shutdown still aborts", async () => {
		const h = await harness({ branch: CHANGE_BRANCH });
		await h.start();
		const session = getSession();
		expect(session?.shutdownSignal.aborted).toBe(false);
		failing = true;
		await expect(h.pi.fire("session_shutdown", {}, h.ctx)).resolves.not.toThrow();
		expect(session?.shutdownSignal.aborted).toBe(true);
		await expect(h.start()).resolves.not.toThrow();
	});
});

describe("session_start in a child session", () => {
	test("no resume card at child session_start", async () => {
		const h = await harness({ branch: CHANGE_BRANCH });
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.pi.fire("session_start", { type: "session_start", reason: "startup" }, asChild(h.ctx));
		expect(resumeMessages(h.pi.entries)).toEqual([]);
	});

	test("a child never replaces the parent session or clears its shared state", async () => {
		const h = await harness({ branch: CHANGE_BRANCH });
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.start();
		const parent = getSession();
		const forge = parent?.forge;
		expect(forge).toBeDefined();
		const generation = gateMemoGeneration();
		let release!: () => void;
		const held = withEvidenceLock(() => new Promise<void>((r) => (release = r)));
		const child = asChild(h.ctx);
		await h.pi.fire("session_start", { type: "session_start", reason: "startup" }, child);
		let drained = false;
		const shutdown = h.pi.fire("session_shutdown", { type: "session_shutdown" }, child).then(() => (drained = true));
		await new Promise((r) => setTimeout(r, 20));
		expect(drained).toBe(true);
		expect(getSession()).toBe(parent);
		expect(getSession()?.forge).toBe(forge);
		expect(parent?.shutdownSignal.aborted).toBe(false);
		expect(gateMemoGeneration()).toBe(generation);
		release();
		await held;
		await shutdown;
	});

	test("a child with no session yet gets one with the forge target only", async () => {
		const h = await harness({ branch: CHANGE_BRANCH });
		await h.pi.fire("session_start", { type: "session_start", reason: "startup" }, asChild(h.ctx));
		expect(getSession()?.forgeTarget()).toBeDefined();
		expect(getSession()?.forge).toBeUndefined();
	});
});

describe("derived advance with a pull request", () => {
	test("passes merged: true when the pull request is merged", async () => {
		const advance = await import("../../src/engine/advance.ts");
		const spy = vi.spyOn(advance, "advancePhase");
		const h = await harness({ branch: CHANGE_BRANCH });
		const pr = await h.world.seedPullRequest({ head: CHANGE_BRANCH, merged: true, state: "closed" });
		const body = allDone(resumeBody(h.head)).replace(/^PR: .*$/m, `PR: #${pr}`);
		await h.world.seedIssue({ title: "per-ip-cap", body, labels: BUILD_LABELS });
		await h.start();
		// Precedence 2: a merged pull request moves the change to close from any phase before it.
		expect(spy).toHaveBeenCalledWith(expect.anything(), expect.any(Number), "close", expect.anything(), { merged: true });
		spy.mockRestore();
	});

	test("passes merged: false without a pull request", async () => {
		const advance = await import("../../src/engine/advance.ts");
		const spy = vi.spyOn(advance, "advancePhase");
		const h = await harness({ branch: CHANGE_BRANCH });
		await h.world.seedIssue({ title: "per-ip-cap", body: allDone(resumeBody(h.head)), labels: BUILD_LABELS });
		await h.start();
		expect(spy).toHaveBeenCalledWith(expect.anything(), expect.any(Number), "review", expect.anything(), { merged: false });
		spy.mockRestore();
	});
});

describe("pull request feedback poll at session start", () => {
	test("runs after the approval poll and the spec cascade", async () => {
		const poll = await import("../../src/interaction/poll.ts");
		const cascade = await import("../../src/interaction/spec-cascade.ts");
		const feedback = await import("../../src/ship/feedback-poll.ts");
		const order: string[] = [];
		const a = vi.spyOn(poll, "pollApprovals").mockImplementation(async () => void order.push("approvals"));
		const c = vi.spyOn(cascade, "runSpecCascade").mockImplementation(async () => (order.push("cascade"), false));
		const f = vi.spyOn(feedback, "pollFeedback").mockImplementation(async () => (order.push("feedback"), { skipped: true }));
		const h = await harness({ branch: CHANGE_BRANCH });
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.start();
		expect(order).toEqual(["approvals", "cascade", "feedback"]);
		a.mockRestore();
		c.mockRestore();
		f.mockRestore();
	});

	test("Poll fails at session start: recorded, the session starts and the card is shown", async () => {
		const failing = (world: MemoryWorld): Forge =>
			new Proxy(world.forge, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (prop !== "listReviewComments" || typeof value !== "function") return value;
					return () => Promise.reject(new Error("review comments unavailable"));
				},
			});
		const h = await harness({ branch: CHANGE_BRANCH, forge: failing });
		const pr = await h.world.seedPullRequest({ head: CHANGE_BRANCH });
		const body = allDone(resumeBody(h.head)).replace(/^PR: .*$/m, `PR: #${pr}`);
		await h.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", "livespec:phase/ship"] });
		execFileSync("git", ["update-ref", `refs/remotes/origin/${CHANGE_BRANCH}`, "HEAD"], { cwd: h.root });
		await expect(h.start()).resolves.toBeUndefined();
		expect(getSession()?.errors.join("\n")).toContain("review comments unavailable");
		const [resume] = resumeMessages(h.pi.entries);
		expect(resume?.content).toContain("· ship");
		expect(await cardText(h.pi, h.ctx)).toContain("· ship");
	});
});
