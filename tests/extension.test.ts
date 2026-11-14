import { describe, expect, it, vi } from "vitest";
import extension from "../src/extension.ts";
import { readVersion } from "../src/version.ts";
import { makeRepo, writeIn } from "./helpers/repo.ts";

type Handler = (args: string, ctx: unknown) => Promise<void> | void;

function loadExtension(cwd = process.cwd()) {
	const commands = new Map<string, { description?: string; handler: Handler }>();
	const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
	const sendMessage = vi.fn();
	const notify = vi.fn();
	const api = {
		registerCommand: (name: string, options: { description?: string; handler: Handler }) => {
			commands.set(name, options);
		},
		registerTool: (tool: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) => {
			tools.set(tool.name, tool);
		},
		sendMessage,
	};
	extension(api as never);
	return { commands, tools, sendMessage, notify, ctx: { cwd, ui: { notify } } };
}

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
		const { commands, notify, ctx } = loadExtension(root);
		await commands.get("livespec")!.handler("", ctx);
		expect(notify).not.toHaveBeenCalled();
		const { readdirSync } = await import("node:fs");
		expect(readdirSync(root)).toEqual([".git"]);
	});

	it("unknown subcommand prints usage", async () => {
		const { commands, sendMessage, ctx } = loadExtension();
		await commands.get("livespec")!.handler("nonsense", ctx);
		const content = (sendMessage.mock.calls[0]![0] as { content: string }).content;
		expect(content).toContain("validate");
		expect(content).toContain("migrate-openspec");
	});

	it("validate notifies error and tool returns results", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/a/spec.md", "# a\n\n## Purpose\nx\n\n## Requirements\n\n### Requirement: R\nThe system SHALL x.\n");
		const { commands, tools, sendMessage, notify, ctx } = loadExtension(root);
		await commands.get("livespec")!.handler("validate", ctx);
		expect(notify).toHaveBeenCalledWith(expect.any(String), "error");
		const text = (sendMessage.mock.calls[0]![0] as { content: string }).content;
		const out = (await tools.get("spec_validate")!.execute("id", {}, undefined, undefined, ctx)) as {
			content: { text: string }[];
			details: { results: unknown[] };
		};
		expect(out.content[0]!.text).toBe(text);
		expect(out.details.results.length).toBeGreaterThan(0);
	});

	it("validate reports missing specs folder", async () => {
		const root = await makeRepo();
		const { commands, sendMessage, notify, ctx } = loadExtension(root);
		await commands.get("livespec")!.handler("validate", ctx);
		expect((sendMessage.mock.calls[0]![0] as { content: string }).content).toMatch(/nothing to validate/i);
		expect(notify).not.toHaveBeenCalled();
	});
});
