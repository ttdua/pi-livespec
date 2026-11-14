import { describe, expect, it, vi } from "vitest";
import extension from "../src/extension.ts";
import { readVersion } from "../src/version.ts";

type Handler = (args: string, ctx: unknown) => Promise<void> | void;

function loadExtension() {
	const commands = new Map<string, { description?: string; handler: Handler }>();
	const sendMessage = vi.fn();
	const notify = vi.fn();
	const api = {
		registerCommand: (name: string, options: { description?: string; handler: Handler }) => {
			commands.set(name, options);
		},
		sendMessage,
	};
	extension(api as never);
	return { commands, sendMessage, notify, ctx: { ui: { notify } } };
}

describe("livespec extension", () => {
	it("registers the livespec command", () => {
		const { commands } = loadExtension();
		expect([...commands.keys()]).toEqual(["livespec"]);
	});

	it("prints the package version and does nothing else", async () => {
		const { commands, sendMessage, notify, ctx } = loadExtension();
		await commands.get("livespec")!.handler("", ctx);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		const message = sendMessage.mock.calls[0]![0] as { content: string };
		expect(message.content).toContain(readVersion());
		expect(notify).not.toHaveBeenCalled();
	});
});
