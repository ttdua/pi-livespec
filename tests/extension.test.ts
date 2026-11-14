import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runValidateCommand } from "../src/commands/validate.ts";
import extension from "../src/extension.ts";
import { readVersion } from "../src/version.ts";
import { commitAll, makeRepo, writeIn } from "./helpers/repo.ts";

type Handler = (args: string, ctx: unknown) => Promise<void> | void;

function loadExtension(cwd = process.cwd()) {
	const commands = new Map<string, { description?: string; handler: Handler }>();
	const tools = new Map<string, { name: string; parameters?: unknown; execute: (...a: unknown[]) => Promise<unknown> }>();
	const sendMessage = vi.fn();
	const notify = vi.fn();
	const api = {
		registerCommand: (name: string, options: { description?: string; handler: Handler }) => {
			commands.set(name, options);
		},
		registerTool: (tool: { name: string; parameters?: unknown; execute: (...a: unknown[]) => Promise<unknown> }) => {
			tools.set(tool.name, tool);
		},
		sendMessage,
	};
	extension(api as never);
	return { commands, tools, sendMessage, notify, ctx: { cwd, ui: { notify } } };
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
	it("registers the livespec command and spec_validate tool", () => {
		const { commands, tools } = loadExtension();
		expect([...commands.keys()]).toEqual(["livespec"]);
		expect([...tools.keys()]).toEqual(["spec_validate"]);
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
});
