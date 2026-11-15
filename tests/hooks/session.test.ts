import { afterEach, describe, expect, test, vi } from "vitest";
import { TEMPLATE_MARKER } from "../../src/core/templates.ts";
import { getSession, setSession } from "../../src/hooks/session-store.ts";
import { gitStatus } from "../helpers/repo.ts";
import { allDone, BUILD_LABELS, CHANGE_BRANCH, cardText, cleanupHomes, contextCall, harness, type Msg, resumeBody, TREE_SHA } from "./helpers.ts";
import { writeIn } from "../helpers/repo.ts";

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
		expect(resumeMessages(h.pi.entries)[0]?.content).toContain("· review");
	});

	test("Not blocking", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, activeTree: `/clone/${TREE_SHA}` });
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		let settled = false;
		void h.content.autoCheck.outcome.promise.then(() => (settled = true));
		await h.start();
		await vi.waitFor(() => expect(h.content.autoCheck.calls).toHaveLength(1));
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

	test("session_start kicks off autoCheck without awaiting it", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, activeTree: `/clone/${TREE_SHA}` });
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.start();
		await vi.waitFor(() => expect(h.content.autoCheck.calls).toHaveLength(1));
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
	test("wraps long lines to the viewport width", async () => {
		const { wrapLines } = await import("../../src/hooks/resume-entry.ts");
		expect(wrapLines("abcdef\n\nxy", 4)).toEqual(["abcd", "ef", "", "xy"]);
		expect(wrapLines("ab", 0)).toEqual(["a", "b"]);
	});
});
