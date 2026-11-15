// A fake ExtensionAPI: records `pi.on` handlers, commands, tools and sent
// messages, and fires events the way pi does (handlers in registration order,
// the last defined result wins).

import { vi } from "vitest";

type Handler = (event: unknown, ctx: unknown) => unknown;

export type SentMessage = { customType: string; content: string; display: boolean };

export type FakeCtx = {
	cwd: string;
	hasUI: boolean;
	ui: { notify: ReturnType<typeof vi.fn> };
	isProjectTrusted: () => boolean;
};

export class FakePi {
	readonly handlers = new Map<string, Handler[]>();
	readonly commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => unknown }>();
	readonly tools = new Map<string, { name: string; execute: (...a: unknown[]) => Promise<unknown> }>();
	readonly sent: SentMessage[] = [];

	/** The object handed to the code under test as `ExtensionAPI`. */
	readonly api = {
		on: (event: string, handler: Handler) => {
			const list = this.handlers.get(event) ?? [];
			list.push(handler);
			this.handlers.set(event, list);
		},
		registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: unknown) => unknown }) => {
			this.commands.set(name, options);
		},
		registerTool: (tool: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) => {
			this.tools.set(tool.name, tool);
		},
		sendMessage: (message: SentMessage) => {
			this.sent.push(message);
		},
	};

	/** Runs every handler of `event` in order and returns the last defined result. */
	async fire(event: string, payload: unknown, ctx: unknown): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) {
			const out = await handler(payload, ctx);
			if (out !== undefined) result = out;
		}
		return result;
	}
}

export function fakeCtx(cwd: string, trusted = true): FakeCtx {
	return { cwd, hasUI: false, ui: { notify: vi.fn() }, isProjectTrusted: () => trusted };
}
