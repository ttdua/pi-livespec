// The `durable-docs` check and the ship gate's "Needs your confirmation" payload section (design D6).

import type { Result } from "../core/result.ts";
import type { CheckFn } from "../engine/registry.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { DECISIONS, type DurableFacts, durableDocsRule } from "./durable-docs.ts";

const NOT_NEEDED = "not needed";

/** Errors as `error`, confirmation items as `warning`; nothing without a ship context (outside `ship`). */
export const durableDocsCheck: CheckFn = async ({ ship }) => {
	if (ship === undefined) return [];
	if ("refused" in ship) return [{ code: "durable-docs", severity: "error", message: `the durable docs cannot be checked: ${ship.refused}` }];
	const outcome = durableDocsRule(ship.facts);
	const result = (severity: Result["severity"]) => (message: string): Result => ({ code: "durable-docs", severity, message });
	return [...outcome.errors.map(result("error")), ...outcome.confirm.map(result("warning"))];
};

/** `not needed` rows with their reason, verbatim. */
function reasons(facts: DurableFacts): string[] {
	return facts.rows.filter((r) => r.status.startsWith(NOT_NEEDED)).map((r) => `- ${r.file}: ${r.status}`);
}

/** The "Needs your confirmation" section of the ship gate; undefined when there is nothing to confirm. */
export function confirmationSection(state: ChangeState): string | undefined {
	const facts = state.ship?.durableFacts;
	if (facts === undefined) return undefined;
	const decisions = facts.added.filter((f) => f.startsWith(DECISIONS)).map((f) => `- new decision: ${f}`);
	const lines = [...durableDocsRule(facts).confirm.map((c) => `- ${c}`), ...reasons(facts), ...decisions];
	return lines.length === 0 ? undefined : ["Needs your confirmation:", ...lines].join("\n");
}
