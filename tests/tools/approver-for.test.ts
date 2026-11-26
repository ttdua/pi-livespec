import { describe, expect, test, vi } from "vitest";
import type { DialogFactory, DialogOutcome } from "../../src/interaction/dialog/types.ts";
import { type ApproverCtx, uiOf } from "../../src/tools/approver-for.ts";

const CANCEL: DialogOutcome = { kind: "cancelled" };
const factory = (() => ({ render: () => [], invalidate: () => {} })) as DialogFactory<DialogOutcome>;

function ctxOf(mode: ApproverCtx["mode"], custom?: ApproverCtx["ui"]["custom"]): ApproverCtx {
	return { hasUI: true, mode, ui: { select: async () => undefined, input: async () => undefined, ...(custom ? { custom } : {}) } };
}

describe("uiOf", () => {
	test("mode tui with ui.custom → dialog calls ui.custom with the factory", async () => {
		const custom = vi.fn(async () => CANCEL) as unknown as NonNullable<ApproverCtx["ui"]["custom"]>;
		const ui = uiOf(ctxOf("tui", custom));
		expect(ui.dialog).toBeDefined();
		expect(await ui.dialog?.(factory)).toEqual(CANCEL);
		expect(custom).toHaveBeenCalledWith(factory);
	});

	test("mode rpc → no dialog", () => {
		const custom = vi.fn(async () => CANCEL) as unknown as NonNullable<ApproverCtx["ui"]["custom"]>;
		expect(uiOf(ctxOf("rpc", custom)).dialog).toBeUndefined();
	});

	test("mode tui without ui.custom → no dialog", () => {
		expect(uiOf(ctxOf("tui")).dialog).toBeUndefined();
	});

	test("no mode → no dialog", () => {
		const custom = vi.fn(async () => CANCEL) as unknown as NonNullable<ApproverCtx["ui"]["custom"]>;
		expect(uiOf(ctxOf(undefined, custom)).dialog).toBeUndefined();
	});
});
