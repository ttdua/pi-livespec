// A fake ExtensionAPI: records `pi.on` handlers, commands, tools and sent
// messages, and fires events the way pi does (handlers in registration order,
// the last defined result wins; a blocking `tool_call` result stops the chain).

import { vi } from "vitest";
import type { ApproverCtx } from "../../src/tools/approver-for.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

export type SentMessage = { customType: string; content: string; display: boolean };

export type SelectFn = (title: string, options: string[]) => Promise<string | undefined>;
export type ConfirmFn = (title: string, message: string) => Promise<boolean>;
export type InputFn = (title: string, placeholder?: string) => Promise<string | undefined>;

/** `ctx.ui.custom`, narrowed to what livespec passes. */
export type CustomFn = NonNullable<ApproverCtx["ui"]["custom"]>;

/**
 * Scripted dialog answers; a missing one cancels (`undefined`, or `false` for `confirm`). `mode` and
 * `custom` are set on the ctx only when given, as a host without them would.
 */
export type FakeUI = { hasUI?: boolean; mode?: "tui" | "rpc" | "json" | "print"; select?: SelectFn; confirm?: ConfirmFn; input?: InputFn; custom?: CustomFn };

export type FakeCtx = {
	cwd: string;
	hasUI: boolean;
	mode?: FakeUI["mode"];
	ui: {
		notify: ReturnType<typeof vi.fn>;
		select: ReturnType<typeof vi.fn<SelectFn>>;
		confirm: ReturnType<typeof vi.fn<ConfirmFn>>;
		input: ReturnType<typeof vi.fn<InputFn>>;
		custom?: CustomFn;
	};
	isProjectTrusted: () => boolean;
	sessionManager: { getSessionId(): string; getHeader(): { type: "session"; id: string; parentSession?: string } };
};

export class FakePi {
	readonly handlers = new Map<string, Handler[]>();
	readonly commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => unknown }>();
	readonly tools = new Map<string, { name: string; parameters?: unknown; execute: (...a: unknown[]) => Promise<unknown> }>();
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
		registerTool: (tool: { name: string; parameters?: unknown; execute: (...a: unknown[]) => Promise<unknown> }) => {
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
		/** Spies only: tests assert on emitted events; nothing is delivered. */
		events: { emit: vi.fn(), on: vi.fn() },
	};

	/**
	 * Runs every handler of `event` in order and returns the last defined result. As in pi's runner,
	 * a `tool_call` handler returning `block: true` stops the chain: later handlers never see the call.
	 */
	async fire(event: string, payload: unknown, ctx: unknown): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) {
			const out = await handler(payload, ctx);
			if (out === undefined) continue;
			result = out;
			if (event === "tool_call" && (out as { block?: unknown }).block === true) return out;
		}
		return result;
	}
}

/** A ctx without UI by default; each dialog answers through the scripted function, or cancels when none is given. */
export function fakeCtx(cwd: string, trusted = true, ui: FakeUI = {}): FakeCtx {
	const select = vi.fn<SelectFn>(ui.select ?? (async () => undefined));
	const confirm = vi.fn<ConfirmFn>(ui.confirm ?? (async () => false));
	const input = vi.fn<InputFn>(ui.input ?? (async () => undefined));
	return {
		cwd,
		hasUI: ui.hasUI ?? false,
		...(ui.mode ? { mode: ui.mode } : {}),
		ui: { notify: vi.fn(), select, confirm, input, ...(ui.custom ? { custom: ui.custom } : {}) },
		isProjectTrusted: () => trusted,
		sessionManager: sessionManagerOf(),
	};
}

function sessionManagerOf(parentSession?: string): FakeCtx["sessionManager"] {
	return {
		getSessionId: () => "fake-session",
		getHeader: () => ({ type: "session", id: "fake-session", ...(parentSession === undefined ? {} : { parentSession }) }),
	};
}

/** The same ctx as a child session: its header names a parent, so `isChildSession` is true without an executor. */
export function asChild(ctx: FakeCtx): FakeCtx {
	return { ...ctx, sessionManager: sessionManagerOf("/sessions/parent.jsonl") };
}
