/** A briefing that satisfies the interaction contract: it recommends `recommended` with a rationale. */
export const validBriefing = (recommended: string) => ({ summary: "Fixture briefing.", recommended, rationale: "Fixture rationale.", author: "agent" as const });

export const BRIEFING = validBriefing("approve");

type Option = { id: string; label: string; description?: string };

/**
 * The `options` and `briefing` a directly built request needs to satisfy the interaction contract: every option
 * described, a recommendation naming `waive` while a check fails, an offered option for a choice kind, else `approve`.
 */
export function contractFields(kind: string, subject: string, snapshot: unknown, options?: Option[]): { options?: Option[]; briefing: ReturnType<typeof validBriefing> } {
	const isChoice = !subject.startsWith("amend:") && kind !== "gate";
	const base = options ?? (isChoice ? [{ id: "A", label: "Option A" }, { id: "B", label: "Option B" }] : undefined);
	const described = base?.map((o) => ({ ...o, description: o.description ?? `Choose ${o.label}.` }));
	const failing = (snapshot as { failingWaivable?: unknown } | undefined)?.failingWaivable;
	const waivable = Array.isArray(failing) && failing.length > 0 && described?.some((o) => o.id === "waive");
	const recommended = waivable ? "waive" : isChoice ? (described?.[0]?.id ?? "A") : "approve";
	return { ...(described ? { options: described } : {}), briefing: validBriefing(recommended) };
}

/** A briefing for a gate where a waivable check fails: `approve` is not offered, so it recommends `waive`. */
export const WAIVE_BRIEFING = validBriefing("waive");
