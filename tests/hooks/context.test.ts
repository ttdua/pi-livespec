import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { ROUTING_NOTE } from "../../src/hooks/routing-note.ts";
import { getSession, setSession } from "../../src/hooks/session-store.ts";
import { CHILD_NOTE } from "../../src/subagents/child.ts";
import { skillNamesOf } from "../content/helpers.ts";
import { asChild } from "./fake-pi.ts";
import {
	BUILD_LABELS,
	CHANGE_BRANCH,
	cardText,
	cleanupHomes,
	contextCall,
	flakyForge,
	harness,
	type Msg,
	promptEvent,
	resumeBody,
	TREE_SHA,
} from "./helpers.ts";

let pack: Pack;

beforeAll(async () => {
	const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
	if (!loaded.ok) throw new Error("default pack must load");
	pack = loaded.pack;
});

afterEach(async () => {
	setSession(undefined);
	await cleanupHomes();
});

const TREE = `/clone/${TREE_SHA}`;
const user = (text: string, timestamp: number): Msg => ({ role: "user", content: text, timestamp });

async function resumed() {
	const h = await harness({ branch: CHANGE_BRANCH, activeTree: TREE });
	const n = await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
	await h.start();
	return { ...h, n };
}

describe("context hooks", () => {
	test("Identical every turn", async () => {
		const h = await resumed();
		const notes: string[] = [];
		const bodies = [
			resumeBody(h.head),
			resumeBody(h.head).replace("- [ ] Q1", "- [x] Q1"),
			resumeBody(h.head).replace("- [x] Q1 (blocking)", "- [ ] Q1 (blocking)"),
			resumeBody(h.head).replace("- [ ] pending", "- [x] done"),
			resumeBody(h.head),
		];
		for (const body of bodies) {
			await h.world.editBodyBehindBack(h.n, body);
			const event = promptEvent();
			await h.pi.fire("before_agent_start", event, h.ctx);
			notes.push(event.systemPromptOptions.sections.livespec as string);
		}
		expect(notes).toHaveLength(5);
		for (const note of notes) expect(note).toBe(ROUTING_NOTE);
	});

	test("the first card the model sees points at specs/product.md, later ones do not", async () => {
		const h = await resumed();
		await h.pi.fire("before_agent_start", promptEvent(), h.ctx);
		const first = await cardText(h.pi, h.ctx, [user("one", 1)]);
		expect(first).toContain("specs/product.md");
		const second = await cardText(h.pi, h.ctx, [user("one", 1)]);
		expect(second).not.toContain("specs/product.md");
		await h.pi.fire("before_agent_start", promptEvent(), h.ctx);
		expect(await cardText(h.pi, h.ctx, [user("two", 2)])).not.toContain("specs/product.md");
	});

	test("Appended at the end", async () => {
		const h = await resumed();
		const input = [user("one", 1), { role: "assistant", content: [{ type: "text", text: "ok" }] }, user("two", 2)];
		const out = await contextCall(h.pi, h.ctx, input);
		expect(out).toHaveLength(input.length + 1);
		expect(out?.slice(0, input.length)).toEqual(input);
		expect(out?.at(-1)).toEqual({ role: "user", customType: "livespec-phase-card", content: expect.any(String), timestamp: 0 });
	});

	test("Cache prefix stable over five turns", async () => {
		const h = await resumed();
		const session: Msg[] = [];
		for (let turn = 1; turn <= 5; turn++) {
			session.push(user(`prompt ${turn}`, turn));
			const event = promptEvent();
			await h.pi.fire("before_agent_start", event, h.ctx);
			expect(event.systemPromptOptions.sections.livespec).toBe(ROUTING_NOTE);
			const out = await contextCall(h.pi, h.ctx, session);
			expect(out?.slice(0, -1)).toEqual(session);
			expect(out?.at(-1)?.customType).toBe("livespec-phase-card");
			expect(session.some((m) => m.customType === "livespec-phase-card")).toBe(false);
			// The card is never persisted: only the assistant reply joins the session.
			session.push({ role: "assistant", content: [{ type: "text", text: `reply ${turn}` }] });
		}
	});

	test("Issue edited between prompts", async () => {
		const h = await resumed();
		await h.pi.fire("before_agent_start", promptEvent(), h.ctx);
		expect(await cardText(h.pi, h.ctx)).toContain("Next: <untrusted>Build U3 — Rate limit per IP.</untrusted>");
		await h.world.editBodyBehindBack(h.n, resumeBody(h.head).replace("- [ ] pending", "- [x] done"));
		// Within the run the card keeps the last snapshot.
		expect(await cardText(h.pi, h.ctx)).toContain("Next: <untrusted>Build U3 — Rate limit per IP.</untrusted>");
		await h.pi.fire("before_agent_start", promptEvent(), h.ctx);
		const card = await cardText(h.pi, h.ctx);
		expect(card).not.toContain("Build U3");
		expect(card).not.toContain("Active units: U3");
	});

	test("refresh rebuilds the card mid-run", async () => {
		const h = await resumed();
		await h.world.editBodyBehindBack(h.n, resumeBody(h.head).replace("- [x] Q1 (blocking)", "- [ ] Q1 (blocking)"));
		expect(await cardText(h.pi, h.ctx)).toContain("Build U3");
		await getSession()?.refresh();
		expect(await cardText(h.pi, h.ctx)).toContain("Next: <untrusted>Answer blocking question Q1 before continuing.</untrusted>");
	});

	test("Initialized project", async () => {
		const h = await resumed();
		const out = (await h.pi.fire("resources_discover", { type: "resources_discover", cwd: h.root, reason: "startup" }, h.ctx)) as {
			skillPaths: string[];
		};
		expect(out.skillPaths).toEqual(skillNamesOf(pack).map((n) => join(TREE, "skills", n)));
	});

	test("No skills exposed", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, activeTree: TREE, files: { ".pi/livespec/flow.yaml": "extends: agent-skills\nphases: 3\n" } });
		await h.start();
		const out = (await h.pi.fire("resources_discover", { type: "resources_discover", cwd: h.root, reason: "startup" }, h.ctx)) as {
			skillPaths: string[];
		};
		expect(out.skillPaths).toEqual([]);
	});

	test("uninitialized project exposes no skills and gets no routing note", async () => {
		const h = await harness({ initialized: false, activeTree: TREE });
		await h.start();
		const out = (await h.pi.fire("resources_discover", { type: "resources_discover", cwd: h.root, reason: "startup" }, h.ctx)) as {
			skillPaths: string[];
		};
		expect(out.skillPaths).toEqual([]);
		const event = promptEvent();
		await h.pi.fire("before_agent_start", event, h.ctx);
		expect(event.systemPromptOptions.sections).toEqual({});
	});

	test("context hook survives a throwing forge", async () => {
		let flaky!: ReturnType<typeof flakyForge>;
		const h = await harness({
			branch: CHANGE_BRANCH,
			forge: (world) => {
				flaky = flakyForge(world.forge);
				return flaky.forge;
			},
		});
		await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
		await h.start();
		flaky.fail(true);
		const event = promptEvent();
		await expect(h.pi.fire("before_agent_start", event, h.ctx)).resolves.toBeUndefined();
		expect(event.systemPromptOptions.sections.livespec).toBe(ROUTING_NOTE);
		const card = await cardText(h.pi, h.ctx, [user("go", 1)]);
		expect(card).toContain("livespec · forge unavailable");
		expect(card).toContain("token expired");
		flaky.fail(false);
		await h.pi.fire("before_agent_start", promptEvent(), h.ctx);
		expect(await cardText(h.pi, h.ctx)).toContain("Next: <untrusted>Build U3 — Rate limit per IP.</untrusted>");
	});

	test("unreachable forge reuses the resolved change and states the card is stale", async () => {
		const h = await resumed();
		await h.world.makeUnreachable();
		await h.pi.fire("before_agent_start", promptEvent(), h.ctx);
		const card = await cardText(h.pi, h.ctx);
		expect(card).toContain(`#${h.n}`);
		expect(card).toContain("Stale: this card is built from cached forge data");
		expect(card).toContain("Read-only: the forge is unreachable, so livespec writes are refused.");
		expect(card).toContain("Next: <untrusted>Build U3 — Rate limit per IP.</untrusted>");
	});

	test("context hook survives a renderer that throws", async () => {
		const h = await resumed();
		const session = getSession();
		if (!session) throw new Error("no session");
		session.card = { ...session.card, kind: "list", open: null as never };
		const input = [user("x", 1)];
		await expect(contextCall(h.pi, h.ctx, input)).resolves.toBeUndefined();
	});

	test("tool_call read of an optional SKILL.md is noted", async () => {
		const h = await harness({ branch: CHANGE_BRANCH, activeTree: TREE });
		const body = resumeBody(h.head).replace("- [ ] pending", "- [x] done");
		await h.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", "livespec:phase/review"] });
		await h.start();
		const read = (path: string) => h.pi.fire("tool_call", { type: "tool_call", toolName: "read", toolCallId: "t", input: { path } }, h.ctx);
		expect(await read(join(TREE, "skills", "code-simplification", "SKILL.md"))).toBeUndefined();
		await read(join(TREE, "skills", "code-review-and-quality", "SKILL.md"));
		await read("/elsewhere/skills/security-and-hardening/SKILL.md");
		await h.pi.fire("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "b", input: { command: "ls" } }, h.ctx);
		// Only optional skills under the active tree are noted: a required skill or another tree is ignored.
		expect(getSession()?.skillReads.list()).toEqual(["code-simplification"]);
		await h.pi.fire("before_agent_start", promptEvent(), h.ctx);
		expect(await cardText(h.pi, h.ctx)).toContain("Needs skill note: code-simplification (record why with skill_note)");
	});

	test("resources_discover survives a failure building the exposed paths", async () => {
		const h = await resumed();
		const session = getSession();
		if (!session) throw new Error("no session");
		Object.defineProperty(session, "pack", {
			get() {
				throw new Error("pack exploded");
			},
		});
		const out = await h.pi.fire("resources_discover", { type: "resources_discover", cwd: h.root, reason: "startup" }, h.ctx);
		expect(out).toEqual({ skillPaths: [] });
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("pack exploded"), "warning");
	});

	test("no session means no hook output", async () => {
		const h = await harness();
		setSession(undefined);
		expect(await h.pi.fire("context", { type: "context", messages: [] }, h.ctx)).toBeUndefined();
		const event = promptEvent();
		await h.pi.fire("before_agent_start", event, h.ctx);
		expect(event.systemPromptOptions.sections).toEqual({});
		expect(await h.pi.fire("resources_discover", { type: "resources_discover", cwd: h.root, reason: "startup" }, h.ctx)).toEqual({ skillPaths: [] });
	});
});

describe("context hooks in a child session", () => {
	test("context hook adds no card in a child", async () => {
		const h = await resumed();
		const child = asChild(h.ctx);
		const out = await contextCall(h.pi, child, [user("one", 1)]);
		expect(out).toBeUndefined();
	});

	test("before_agent_start sets CHILD_NOTE in a child", async () => {
		const h = await resumed();
		const event = promptEvent();
		await h.pi.fire("before_agent_start", event, asChild(h.ctx));
		expect(event.systemPromptOptions.sections.livespec).toBe(CHILD_NOTE);
	});

	test("resources_discover returns no skills in a child", async () => {
		const h = await resumed();
		const out = await h.pi.fire("resources_discover", { type: "resources_discover", cwd: h.root, reason: "startup" }, asChild(h.ctx));
		expect(out).toEqual({ skillPaths: [] });
	});
});

describe("context facts for subagent policy", () => {
	test("turn_end records the turn count and context percent for the next card input", async () => {
		const h = await resumed();
		const ctx = { ...h.ctx, getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 61.5 }) };
		await h.pi.fire("turn_end", { type: "turn_end" }, ctx);
		expect(getSession()?.mainTurns).toEqual({ turnsCompleted: 1, contextPercent: 61.5 });
		await getSession()?.refresh();
		const card = getSession()?.card;
		expect(card?.kind === "change" && card.state.subagents).toMatchObject({ turnsCompleted: 1, contextPercent: 61.5 });
	});

	test("an unknown usage drops the percent; a child's turn_end changes nothing", async () => {
		const h = await resumed();
		await h.pi.fire("turn_end", {}, { ...h.ctx, getContextUsage: () => ({ tokens: null, contextWindow: 100, percent: null }) });
		expect(getSession()?.mainTurns).toEqual({ turnsCompleted: 1 });
		await h.pi.fire("turn_end", {}, asChild(h.ctx));
		expect(getSession()?.mainTurns.turnsCompleted).toBe(1);
	});
});
