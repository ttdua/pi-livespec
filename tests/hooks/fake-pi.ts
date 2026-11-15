// A fake ExtensionAPI: records `pi.on` handlers, commands, tools and sent
// messages, and fires events the way pi does (handlers in registration order,
// the last defined result wins).

import { vi } from "vitest";

type Handler = (event: unknown, ctx: unknown) => unknown;

export type SentMessage = { customType: string; content: string; display: boolean };

export type SelectFn = (title: string, options: string[]) => Promise<string | undefined>;

export type FakeCtx = {
	cwd: string;
	hasUI: boolean;
	ui: { notify: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn<SelectFn>> };
	isProjectTrusted: () => boolean;
};

export class FakePi {
	readonly handlers = new Map<string, Handler[]>();
	readonly commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => unknown }>();
	readonly tools = new Map<string, { name: string; execute: (...a: unknown[]) => Promise<unknown> }>();
	readonly sent: SentMessage[] = [];
	/** UI-only session entries from `appendEntry`; they never reach the LLM. */
	readonly entries: { customType: string; data: unknown }[] = [];
	readonly entryRenderers = new Map<string, (entry: unknown, options: unknown, theme: unknown) => unknown>();

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
		appendEntry: (customType: string, data?: unknown) => {
			this.entries.push({ customType, data });
		},
		registerEntryRenderer: (customType: string, renderer: (entry: unknown, options: unknown, theme: unknown) => unknown) => {
			this.entryRenderers.set(customType, renderer);
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

/** A ctx without UI by default; `ui.select` answers through `select`, or cancels when none is given. */
export function fakeCtx(cwd: string, trusted = true, ui: { hasUI?: boolean; select?: SelectFn } = {}): FakeCtx {
	const select = vi.fn<SelectFn>(ui.select ?? (async () => undefined));
	return { cwd, hasUI: ui.hasUI ?? false, ui: { notify: vi.fn(), select }, isProjectTrusted: () => trusted };
}
