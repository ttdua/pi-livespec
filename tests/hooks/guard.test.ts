import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import extension from "../../src/extension.ts";
import * as classify from "../../src/guard/classify.ts";
import { getSession, setSession } from "../../src/hooks/session-store.ts";
import { cleanupDirs, type ToolHarness, toolHarness } from "../tools/helpers.ts";
import { FakePi, fakeCtx } from "./fake-pi.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	setSession(undefined);
	await cleanupDirs();
});

const BUILD_BODY = "Depends: —\nCapabilities: new [], modified []\nProduct impact: —\n\n## Proposal\nx\n## Design\nx\n## Questions\n\n## Units\n\n## Durable docs\n";
const TREE = "/agent-skills/tree";

type Block = { block: true; reason: string } | undefined;

/** The toolHarness session, with the whole extension loaded on its own fake pi. */
async function guarded(): Promise<{ h: ToolHarness; pi: FakePi; ctx: ReturnType<typeof fakeCtx>; call(toolName: string, input: unknown): Promise<Block> }> {
	const h = await toolHarness({ change: { body: BUILD_BODY } });
	const pi = new FakePi();
	extension(pi.api as never);
	const ctx = fakeCtx(h.root);
	let id = 0;
	const call = async (toolName: string, input: unknown) => (await pi.fire("tool_call", { type: "tool_call", toolName, toolCallId: `t${++id}`, input }, ctx)) as Block;
	return { h, pi, ctx, call };
}

const flowFile = (h: ToolHarness) => readFileSync(join(h.root, ".pi/livespec/config.yaml"), "utf8");

describe("command-guards", () => {
	test("Reason names the tool", async () => {
		const { call } = await guarded();
		const out = await call("bash", { command: "gh issue edit 6 --body-file body.md" });
		expect(out?.block).toBe(true);
		expect(out?.reason.startsWith("livespec guard:")).toBe(true);
		expect(out?.reason).toContain("spec_write");
	});

	test("Guard error blocks", async () => {
		const { call } = await guarded();
		vi.spyOn(classify, "classifyCommand").mockImplementation(() => {
			throw new Error("parser exploded");
		});
		const out = await call("bash", { command: "ls" });
		expect(out).toEqual({ block: true, reason: "livespec guard failed: parser exploded; the command was not run" });
	});

	test("Flow override edit blocked", async () => {
		const { h, call } = await guarded();
		const before = flowFile(h);
		const out = await call("edit", { path: ".pi/livespec/flow.yaml", edits: [{ oldText: "a", newText: "b" }] });
		expect(out?.block).toBe(true);
		expect(out?.reason).toMatch(/^livespec guard:/);
		expect(flowFile(h)).toBe(before);
	});

	test("Path traversal", async () => {
		const { call } = await guarded();
		const out = await call("write", { path: "src/../.pi/livespec/config.yaml", content: "gate: self\n" });
		expect(out?.block).toBe(true);
		expect(await call("write", { path: "src/limit.ts", content: "x\n" })).toBeUndefined();
	});

	test("write and edit paths are read the way pi's tools read them", async () => {
		const { h, call } = await guarded();
		const forms = ["@.pi/livespec/flow.yaml", `file://${join(h.root, ".pi/livespec/flow.yaml")}`, join(h.root, ".pi/livespec/config.yaml")];
		for (const path of forms) expect((await call("write", { path, content: "x" }))?.block, path).toBe(true);
	});

	test("a call without a path or command is blocked", async () => {
		const { call } = await guarded();
		expect((await call("edit", {}))?.reason).toMatch(/^livespec guard failed: .*; the command was not run$/);
		expect((await call("bash", {}))?.block).toBe(true);
	});

	test("Manual tick blocked", async () => {
		const { h, call } = await guarded();
		const before = await h.world.bodyOf(h.n);
		const out = await call("bash", { command: `gh issue edit ${h.n} --body "- [x] done"` });
		expect(out?.block).toBe(true);
		expect(await h.world.bodyOf(h.n)).toBe(before);
	});

	test("guard runs before skill-read recording", async () => {
		const { h, pi, call } = await guarded();
		h.session.activeTree = TREE;
		const later = (pi.handlers.get("tool_call") ?? []).slice(1);
		expect(later.length).toBeGreaterThan(0);
		const spies = later.map((handler) => vi.fn(handler));
		pi.handlers.set("tool_call", [(pi.handlers.get("tool_call") ?? [])[0] as never, ...spies]);
		expect((await call("bash", { command: "git push" }))?.block).toBe(true);
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		expect(await call("read", { path: join(TREE, "skills", "debugging-and-error-recovery", "SKILL.md") })).toBeUndefined();
		expect(getSession()?.skillReads.list()).toEqual(["debugging-and-error-recovery"]);
	});

	test("a repository alias is read and checked", async () => {
		const { h, call } = await guarded();
		h.git("config", "alias.ship", "push");
		expect((await call("bash", { command: "git ship origin" }))?.reason).toContain("rule push");
		expect(await call("bash", { command: "git status" })).toBeUndefined();
	});

	test("an alias lookup failure treats unknown subcommands mentioning push as pushes", async () => {
		const { h, call } = await guarded();
		vi.spyOn(h.session.git, "aliases").mockRejectedValue(new Error("config unreadable"));
		expect((await call("bash", { command: "git pp push" }))?.block).toBe(true);
		expect(await call("bash", { command: "git pp" })).toBeUndefined();
	});

	test("in an uninitialized project every call is allowed", async () => {
		const { h, call } = await guarded();
		h.session.config = { ...h.session.config, project: null };
		expect(await call("bash", { command: "git push" })).toBeUndefined();
		expect(await call("edit", { path: ".pi/livespec/flow.yaml" })).toBeUndefined();
		expect(await call("write", { path: "src/../.pi/livespec/config.yaml" })).toBeUndefined();
		setSession(undefined);
		expect(await call("bash", { command: "gh issue edit 1 --body x" })).toBeUndefined();
	});
});
