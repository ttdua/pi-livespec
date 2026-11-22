// The waivable plan check `size-limits`: a change with more units or capabilities than the pack's limits.

import type { Change } from "../core/change.ts";
import type { Result } from "../core/result.ts";
import { registerCheck } from "../engine/registry.ts";

const CHECK = "size-limits";

export type SizeLimits = { max_units?: number; max_capabilities?: number };
export type Exceeded = { section: "Units" | "Capabilities"; message: string };

/** The counts the limits apply to: declared capabilities (new and modified) and `## Units` blocks. */
export function changeSize(change: Change): { capabilities: number; units: number } {
	const caps = change.header.capabilities;
	return { capabilities: caps === undefined ? 0 : caps.new.length + caps.modified.length, units: change.units.length };
}

/** The `max_units` and `max_capabilities` values of a pack's `limits`, without the other keys. */
export function sizeLimitsOf(limits: Record<string, number> | undefined): SizeLimits {
	return {
		...(limits?.max_units !== undefined ? { max_units: limits.max_units } : {}),
		...(limits?.max_capabilities !== undefined ? { max_capabilities: limits.max_capabilities } : {}),
	};
}

/** One entry per exceeded limit; a limit that is not set never counts. */
export function exceededLimits(size: { capabilities: number; units: number }, limits: SizeLimits): Exceeded[] {
	const out: Exceeded[] = [];
	if (limits.max_units !== undefined && size.units > limits.max_units) out.push({ section: "Units", message: `${size.units} units exceed max_units ${limits.max_units}` });
	if (limits.max_capabilities !== undefined && size.capabilities > limits.max_capabilities) {
		out.push({ section: "Capabilities", message: `${size.capabilities} capabilities exceed max_capabilities ${limits.max_capabilities}` });
	}
	return out;
}

/** One error per exceeded limit; a limit the pack does not set never fails. */
export function sizeLimitResults(change: Change, limits: Record<string, number> | undefined): Result[] {
	return exceededLimits(changeSize(change), sizeLimitsOf(limits)).map((e) => ({ code: CHECK, severity: "error", section: e.section, message: e.message }));
}

export function registerSizeLimits(): void {
	registerCheck(CHECK, async (ctx) => sizeLimitResults(ctx.change, ctx.limits), { waivable: true });
}
