// Moves a change's phase label: add the new label first, then remove the old
// one, so a failure never leaves the issue without a phase label. Retries are
// idempotent (design.md, "advancePhase").

import { phaseLabel } from "../forge/labels.ts";
import type { Forge } from "../forge/types.ts";
import type { Pack } from "./pack-types.ts";
import { phaseFromLabels } from "./snapshot.ts";

export type AdvanceResult = { status: "moved"; from: string } | { status: "unchanged" } | { status: "refused"; reason: string };

const REPAIR_HINT = "keep exactly one livespec:phase/* label on the issue, then retry";

/** Every phase reachable through `requires` from `phase`, i.e. the phases before it. */
function earlierPhases(pack: Pack, phase: string): Set<string> {
	const byId = new Map(pack.phases.map((p) => [p.id, p]));
	const seen = new Set<string>();
	const pending = [...(byId.get(phase)?.requires ?? [])];
	while (pending.length > 0) {
		const id = pending.pop() as string;
		if (seen.has(id)) continue;
		seen.add(id);
		pending.push(...(byId.get(id)?.requires ?? []));
	}
	return seen;
}

/** Forward to a phase that requires `from`, or back to any phase before `from`. */
function isAllowedMove(pack: Pack, from: string, to: string): boolean {
	const target = pack.phases.find((p) => p.id === to);
	return target !== undefined && (target.requires.includes(from) || earlierPhases(pack, from).has(to));
}

type Plan =
	| { kind: "unchanged" }
	| { kind: "move"; from: string }
	| { kind: "finish"; from: string }
	| { kind: "refuse"; reason: string };

/** Classifies the current phase labels against the target (pure). */
export function planMove(pack: Pack, labels: string[], to: string): Plan {
	if (!pack.phases.some((p) => p.id === to)) return { kind: "refuse", reason: `${to} is not a phase of the flow pack` };
	const phase = phaseFromLabels(labels);
	if (phase.kind === "ok") {
		if (phase.id === to) return { kind: "unchanged" };
		if (!isAllowedMove(pack, phase.id, to)) {
			return { kind: "refuse", reason: `cannot move from ${phase.id} to ${to}: ${to} does not follow ${phase.id} and is not an earlier phase` };
		}
		return { kind: "move", from: phase.id };
	}
	if (phase.kind === "ambiguous" && phase.ids.length === 2 && phase.ids.includes(to)) {
		return { kind: "finish", from: phase.ids.find((id) => id !== to) as string };
	}
	const found = phase.kind === "ambiguous" ? phase.ids.join(", ") : "none";
	return { kind: "refuse", reason: `cannot move to ${to}: the issue has phase labels (${found}); ${REPAIR_HINT}` };
}

export async function advancePhase(forge: Forge, n: number, to: string, pack: Pack): Promise<AdvanceResult> {
	const issue = await forge.getIssue(n);
	const plan = planMove(pack, issue.labels, to);
	switch (plan.kind) {
		case "unchanged":
			return { status: "unchanged" };
		case "refuse":
			return { status: "refused", reason: plan.reason };
		case "move":
			await forge.addLabels(n, [phaseLabel(to)]);
			await forge.removeLabels(n, [phaseLabel(plan.from)]);
			return { status: "moved", from: plan.from };
		case "finish":
			await forge.removeLabels(n, [phaseLabel(plan.from)]);
			return { status: "moved", from: plan.from };
	}
}
