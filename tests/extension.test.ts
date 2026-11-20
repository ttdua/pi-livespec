import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runValidateCommand } from "../src/commands/validate.ts";
import extension from "../src/extension.ts";
import type { SessionDeps } from "../src/hooks/session.ts";
import { readVersion } from "../src/version.ts";
import { commitAll, makeRepo, writeIn } from "./helpers/repo.ts";

type Handler = (args: string, ctx: unknown) => Promise<void> | void;

const homes: string[] = [];
afterEach(() => {
	for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
	const home = mkdtempSync(join(tmpdir(), "ls-ext-home-"));
	homes.push(home);
	return home;
}

function loadExtension(cwd = process.cwd(), deps: Partial<SessionDeps> = {}) {
	const commands = new Map<string, { description?: string; handler: Handler }>();
	const tools = new Map<string, { name: string; parameters?: unknown; execute: (...a: unknown[]) => Promise<unknown> }>();
	const sendMessage = vi.fn();
	const notify = vi.fn();
	const events: string[] = [];
	const api = {
		on: (event: string) => {
			if (!events.includes(event)) events.push(event);
		},
		appendEntry: vi.fn(),
		registerEntryRenderer: vi.fn(),
		registerCommand: (name: string, options: { description?: string; handler: Handler }) => {
			commands.set(name, options);
		},
		registerTool: (tool: { name: string; parameters?: unknown; execute: (...a: unknown[]) => Promise<unknown> }) => {
			tools.set(tool.name, tool);
		},
		sendMessage,
	};
	extension(api as never, deps);
	return { commands, tools, events, sendMessage, notify, ctx: { cwd, ui: { notify }, isProjectTrusted: () => true, getSystemPromptOptions: () => ({ skills: [] }) } };
}

/** Map of every file path (relative) to its contents, excluding .git. */
function snapshot(root: string, dir = ""): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of readdirSync(join(root, dir)).sort()) {
		if (name === ".git") continue;
		const rel = join(dir, name);
		if (statSync(join(root, rel)).isDirectory()) Object.assign(out, snapshot(root, rel));
		else out[rel] = readFileSync(join(root, rel), "utf8");
	}
	return out;
}

const NO_SCENARIO = "# a\n\n## Purpose\nx\n\n## Requirements\n\n### Requirement: R\nThe system SHALL x.\n";
type ToolOut = { content: { type: string; text: string }[]; details: { results: unknown[] }; isError?: boolean };

describe("livespec extension", () => {
	it("registers the livespec command and the livespec tools", () => {
		const { commands, tools } = loadExtension();
		expect([...commands.keys()]).toEqual(["livespec"]);
		expect([...tools.keys()].sort()).toEqual(
			["spec_validate", "spec_status", "spec_next", "skill_note", "spec_write", "change_new", "change_start", "spec_gate", "plan_units", "unit_amend", "unit_start", "unit_finish", "spec_question", "spec_stuck", "subagent_dispatch", "subagent_answer", "subagent_packet", "subagent_record", "finding_rebut", "forge_read", "lane_open", "lane_merge"].sort(),
		);
	});

	it("registers the session and context hooks", () => {
		const { events } = loadExtension();
		for (const event of ["session_start", "before_agent_start", "context", "tool_call", "resources_discover"]) {
			expect(events).toContain(event);
		}
	});

	it("Usage lists subcommands", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/a/spec.md", NO_SCENARIO);
		const before = snapshot(root);
		const { commands, sendMessage, notify, ctx } = loadExtension(root);
		await commands.get("livespec")!.handler("nonsense", ctx);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		const content = (sendMessage.mock.calls[0]![0] as { content: string }).content;
		expect(content).toBe(
			"Usage: /livespec [validate | migrate-openspec | init | doctor | next | account [name] | skills <status|update|pin <sha>|unpin|rollback>]",
		);
		for (const sub of ["validate", "migrate-openspec", "init", "doctor", "next", "account [name]", "skills"]) expect(content).toContain(sub);
		expect(notify).not.toHaveBeenCalled();
		expect(snapshot(root)).toEqual(before);
	});

	it("doctor routes to the checks and reports a missing clone", async () => {
		const root = await makeRepo();
		const home = tempHome();
		const detect = async () => {
			throw new Error("no forge in this test");
		};
		const { commands, sendMessage, notify, ctx } = loadExtension(root, { home, detect });
		await commands.get("livespec")!.handler("doctor", ctx);
		const content = (sendMessage.mock.calls[0]![0] as { content: string }).content;
		expect(content).toContain("error clone: agent-skills is not cloned");
		expect(content).toContain("forge detection failed: no forge in this test");
		expect(notify).toHaveBeenCalledWith("livespec doctor found errors", "error");
	});

	it("skills routes to the content manager", async () => {
		const root = await makeRepo();
		const home = tempHome();
		const { commands, sendMessage, ctx } = loadExtension(root, { home });
		await commands.get("livespec")!.handler("skills bogus", ctx);
		expect((sendMessage.mock.calls[0]![0] as { content: string }).content).toBe(
			"Usage: /livespec skills <status|update|pin <sha>|unpin|rollback>",
		);
	});

	it("handler resolves when sendMessage throws", async () => {
		const { commands, sendMessage, ctx } = loadExtension();
		sendMessage.mockImplementation(() => {
			throw new Error("transport closed");
		});
		await expect(commands.get("livespec")!.handler("", ctx)).resolves.toBeUndefined();
	});

	it("handler resolves when notify throws", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/a/spec.md", NO_SCENARIO);
		const { commands, notify, ctx } = loadExtension(root);
		notify.mockImplementation(() => {
			throw new Error("ui gone");
		});
		await expect(commands.get("livespec")!.handler("validate", ctx)).resolves.toBeUndefined();
		expect(notify).toHaveBeenCalled();
	});

	it("account without a livespec session says to run init", async () => {
		const root = await makeRepo();
		const { commands, sendMessage, notify, ctx } = loadExtension(root);
		await commands.get("livespec")!.handler("account ttdua", ctx);
		expect(sendMessage.mock.calls[0]![0]).toMatchObject({
			customType: "livespec-account",
			content: "livespec is not set up in this project: run /livespec init first.",
		});
		expect(notify).not.toHaveBeenCalled();
	});

	it("next without a livespec session says to run init", async () => {
		const root = await makeRepo();
		const { commands, sendMessage, ctx } = loadExtension(root);
		await commands.get("livespec")!.handler("next", ctx);
		expect((sendMessage.mock.calls[0]![0] as { content: string }).content).toContain("/livespec init");
	});

	it("prints the package version", async () => {
		const { commands, sendMessage, ctx } = loadExtension();
		await commands.get("livespec")!.handler("", ctx);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		const message = sendMessage.mock.calls[0]![0] as { content: string };
		expect(message.content).toContain(readVersion());
	});

	it("bare command has no side effects", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/a/spec.md", NO_SCENARIO);
		const before = snapshot(root);
		const { commands, notify, ctx } = loadExtension(root);
		await commands.get("livespec")!.handler("", ctx);
		expect(notify).not.toHaveBeenCalled();
		expect(snapshot(root)).toEqual(before);
	});

	it("unknown subcommand prints usage and changes nothing", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/a/spec.md", NO_SCENARIO);
		const before = snapshot(root);
		const { commands, sendMessage, notify, ctx } = loadExtension(root);
		await commands.get("livespec")!.handler("nonsense", ctx);
		const content = (sendMessage.mock.calls[0]![0] as { content: string }).content;
		expect(content).toContain("validate");
		expect(content).toContain("migrate-openspec");
		expect(notify).not.toHaveBeenCalled();
		expect(snapshot(root)).toEqual(before);
	});

	it("validate notifies error", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/a/spec.md", NO_SCENARIO);
		const { commands, sendMessage, notify, ctx } = loadExtension(root);
		await commands.get("livespec")!.handler("validate", ctx);
		expect(notify).toHaveBeenCalledWith(expect.any(String), "error");
		expect((sendMessage.mock.calls[0]![0] as { content: string }).content).toContain("spec-scenario-missing");
	});

	it("validate on a clean repository does not notify", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/a/spec.md", `${NO_SCENARIO}\n#### Scenario: S\n- **WHEN** w\n- **THEN** t\n`);
		const { commands, notify, ctx } = loadExtension(root);
		await commands.get("livespec")!.handler("validate", ctx);
		expect(notify).not.toHaveBeenCalled();
	});

	it("migrate-openspec moves specs and reports", async () => {
		const root = await makeRepo();
		await writeIn(root, "openspec/specs/a/spec.md", NO_SCENARIO);
		commitAll(root);
		const { commands, sendMessage, notify, ctx } = loadExtension(root);
		await commands.get("livespec")!.handler("migrate-openspec", ctx);
		expect((sendMessage.mock.calls[0]![0] as { content: string }).content).toContain("specs/a/spec.md");
		expect(readFileSync(join(root, "specs/a/spec.md"), "utf8")).toBe(NO_SCENARIO);
		expect(notify).not.toHaveBeenCalled();
	});

	it("migrate-openspec notifies error on conflict", async () => {
		const root = await makeRepo();
		await writeIn(root, "openspec/specs/a/spec.md", NO_SCENARIO);
		await writeIn(root, "specs/a/spec.md", "x");
		commitAll(root);
		const { commands, sendMessage, notify, ctx } = loadExtension(root);
		await commands.get("livespec")!.handler("migrate-openspec", ctx);
		expect(notify).toHaveBeenCalledWith(expect.any(String), "error");
		expect((sendMessage.mock.calls[0]![0] as { content: string }).content).toContain("refused");
	});

	it("migrate-openspec with nothing to migrate does not notify", async () => {
		const root = await makeRepo();
		const { commands, sendMessage, notify, ctx } = loadExtension(root);
		await commands.get("livespec")!.handler("migrate-openspec", ctx);
		expect((sendMessage.mock.calls[0]![0] as { content: string }).content).toMatch(/nothing to migrate/i);
		expect(notify).not.toHaveBeenCalled();
	});

	it("tool is registered with name and empty-object parameters schema", () => {
		const { tools } = loadExtension();
		const tool = tools.get("spec_validate")!;
		expect(tool.name).toBe("spec_validate");
		expect(tool.parameters).toEqual({ type: "object", properties: {} });
	});

	it("tool returns results", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/a/spec.md", NO_SCENARIO);
		const { commands, tools, sendMessage, ctx } = loadExtension(root);
		await commands.get("livespec")!.handler("validate", ctx);
		const text = (sendMessage.mock.calls[0]![0] as { content: string }).content;
		const out = (await tools.get("spec_validate")!.execute("id", {}, undefined, undefined, ctx)) as ToolOut;
		expect(out.content).toHaveLength(1);
		expect(out.content[0]!.type).toBe("text");
		expect(out.content[0]!.text).toBe(text);
		expect(out.details.results.length).toBeGreaterThan(0);
		expect(out.isError).toBe(true);
		const direct = await runValidateCommand(root);
		expect(out.details.results).toEqual(direct.results);
	});

	it("tool and command agree on full results for a clean repository", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/a/spec.md", `${NO_SCENARIO}\n#### Scenario: S\n- **WHEN** w\n- **THEN** t\n`);
		const { tools, ctx } = loadExtension(root);
		const out = (await tools.get("spec_validate")!.execute("id", {}, undefined, undefined, ctx)) as ToolOut;
		expect(out.details.results).toEqual((await runValidateCommand(root)).results);
		expect(out.isError).toBe(false);
	});

	it("tool reports isError for unreadable specs", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs", "a file");
		const { tools, ctx } = loadExtension(root);
		const out = (await tools.get("spec_validate")!.execute("id", {}, undefined, undefined, ctx)) as ToolOut;
		expect(out.isError).toBe(true);
	});

	it("validate reports missing specs folder", async () => {
		const root = await makeRepo();
		const { commands, sendMessage, notify, ctx } = loadExtension(root);
		await commands.get("livespec")!.handler("validate", ctx);
		expect((sendMessage.mock.calls[0]![0] as { content: string }).content).toMatch(/nothing to validate/i);
		expect(notify).not.toHaveBeenCalled();
	});

	it("migrate-openspec reports partial failure with moved list and hint", async () => {
		const root = await makeRepo();
		await writeIn(root, "openspec/specs/a/spec.md", NO_SCENARIO);
		await writeIn(root, "openspec/specs/b/spec.md", NO_SCENARIO);
		commitAll(root);
		// Pre-existing read-only empty specs/b passes preflight, but git mv into it fails after a is moved.
		const { chmodSync, mkdirSync } = await import("node:fs");
		const { commands, sendMessage, notify, ctx } = loadExtension(root);
		mkdirSync(join(root, "specs/b"), { recursive: true });
		chmodSync(join(root, "specs/b"), 0o555);
		try {
			await commands.get("livespec")!.handler("migrate-openspec", ctx);
		} finally {
			chmodSync(join(root, "specs/b"), 0o755);
		}
		if (process.getuid?.() === 0) return;
		const content = (sendMessage.mock.calls[0]![0] as { content: string }).content;
		expect(content).toContain("- specs/a/spec.md");
		expect(content).toContain("Failed: specs/b/spec.md");
		expect(content).toContain("failed midway");
		expect(content).toContain("Recovery:");
		expect(notify).toHaveBeenCalledWith(expect.any(String), "error");
	});
});
