// `/livespec doctor`: runs the built-in and registered checks and prints them.
// Doctor only reports and suggests; `DoctorDeps` exposes read functions only.

import type { ResolvedAccount } from "../accounts/resolve.ts";
import type { ContentManager } from "../content/manager.ts";
import type { LoadedPack } from "../engine/pack-types.ts";
import type { Forge } from "../forge/types.ts";
import { BUILTIN_CHECKS } from "./doctor-checks.ts";
import { messageOf } from "./messages.ts";

export type DoctorResult = { id: string; status: "ok" | "warn" | "error"; message: string; suggestion?: string };
export type DoctorDeps = {
	root: string;
	home: string;
	initialized: boolean;
	pack: LoadedPack;
	loadedSkills: { name: string; filePath: string }[];
	isTrusted: boolean;
	content: ContentManager;
	forge: () => Promise<{ forge: Forge; readOnly: boolean }>;
	exists(p: string): Promise<boolean>;
	listDir(p: string): Promise<string[]>;
	/** The session's last account resolution, read-only; unset without a session. */
	account?: ResolvedAccount;
	/** Why the session refuses forge writes, read-only. */
	accountBlock?: string;
};
export type DoctorCheck = (d: DoctorDeps) => Promise<DoctorResult[]>;

/** Registered checks by id; registering an id again replaces the earlier check. */
const registered = new Map<string, DoctorCheck>();

export function registerDoctorCheck(id: string, run: DoctorCheck): void {
	registered.set(id, run);
}

export function resetDoctorChecksForTests(): void {
	registered.clear();
}

/** Runs every check in order; a check that throws becomes one error result with its id. */
export async function runDoctor(d: DoctorDeps): Promise<DoctorResult[]> {
	const checks = [...BUILTIN_CHECKS, ...[...registered].map(([id, run]) => ({ id, run }))];
	const results: DoctorResult[] = [];
	for (const check of checks) {
		try {
			results.push(...(await check.run(d)));
		} catch (e) {
			results.push({ id: check.id, status: "error", message: `check failed: ${messageOf(e)}` });
		}
	}
	return results;
}

export function formatDoctor(results: DoctorResult[]): string {
	return results
		.map((r) => {
			const line = `${r.status} ${r.id}: ${r.message}`;
			return r.suggestion === undefined ? line : `${line}\n  → ${r.suggestion}`;
		})
		.join("\n");
}
