// Resolves what a packet is for from the role, unit and subject a caller names.

import type { ChangeState } from "../engine/state-types.ts";
import type { ReviewSubject, Role } from "./roles.ts";
import type { Target } from "./source-types.ts";

export type TargetResult = { ok: true; target: Target } | { ok: false; message: string };

export function resolveTarget(state: ChangeState, role: Role, unit?: string, subject?: ReviewSubject): TargetResult {
	const found = unit === undefined ? undefined : state.change.units.find((u) => u.id === unit);
	if (unit !== undefined && found === undefined) return { ok: false, message: `unit ${unit} is not in the change` };
	if (role === "implementer" && found === undefined) return { ok: false, message: "an implementer packet needs a unit" };
	if (role === "reviewer" && subject === undefined) return { ok: false, message: "a reviewer packet needs a subject" };
	if (role === "reviewer" && subject === "unit" && found === undefined) return { ok: false, message: "a reviewer packet with subject unit needs a unit" };
	return { ok: true, target: { role, ...(found ? { unit: found } : {}), ...(subject ? { subject } : {}) } };
}
