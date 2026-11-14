// Built-in named checks over the LS-02 validators, and the runner for the
// checks the active phase lists. Later specs add checks through registerCheck.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { capabilitiesMatchDiff } from "../core/capabilities-diff.ts";
import type { Change } from "../core/change.ts";
import type { Result } from "../core/result.ts";
import { parseSpec } from "../core/spec.ts";
import { validateSpec } from "../core/validate-spec.ts";
import { checkDoneMapsScenarios, validateUnits } from "../core/validate-units.ts";
import type { Git } from "./git.ts";
import type { Pack } from "./pack-types.ts";
import { type CheckContext, type CheckFn, getCheck, registerCheck } from "./registry.ts";
import type { ChangeState } from "./state-types.ts";

const SPECS_PATH = "specs/";

function declaredCapabilities(change: Change): string[] {
	const caps = change.header.capabilities;
	return caps ? [...caps.new, ...caps.modified] : [];
}

function errorResult(code: string, file: string, message: string): Result {
	return { code, severity: "error", file, message };
}

/** Validates one capability's living spec; a missing file, read failure or parser throw becomes a Result. */
async function validateCapability(root: string, capability: string): Promise<Result[]> {
	const file = `${SPECS_PATH}${capability}/spec.md`;
	let text: string;
	try {
		text = await readFile(join(root, file), "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [errorResult("spec-missing", file, `${file} does not exist`)];
		return [errorResult("file-unreadable", file, e instanceof Error ? e.message : String(e))];
	}
	try {
		return validateSpec(parseSpec(text, capability), file);
	} catch (e) {
		return [errorResult("file-parse", file, e instanceof Error ? e.message : String(e))];
	}
}

/** `spec-format`: the living specs of the capabilities the change declares, and no others. */
const specFormat: CheckFn = async ({ root, change }) => {
	const results: Result[] = [];
	for (const capability of declaredCapabilities(change)) results.push(...(await validateCapability(root, capability)));
	return results;
};

/** `capabilities-match-diff`: the declared line against `git diff <Base>..HEAD -- specs/`. */
const capabilitiesMatch: CheckFn = async ({ change, git }) => {
	const base = change.header.base;
	const diff = base === undefined ? "" : await git.diff(base, "HEAD", SPECS_PATH);
	return capabilitiesMatchDiff(change, diff);
};

const BUILTIN_CHECKS: Record<string, CheckFn> = {
	"spec-format": specFormat,
	"units-format": async ({ change }) => validateUnits(change),
	"done-maps-scenarios": async ({ change }) => checkDoneMapsScenarios(change),
	"capabilities-match-diff": capabilitiesMatch,
};

export function registerBuiltinChecks(): void {
	for (const [name, fn] of Object.entries(BUILTIN_CHECKS)) registerCheck(name, fn);
}

registerBuiltinChecks();

/**
 * Runs the checks the active phase lists, in pack order, and concatenates their results.
 * No check runs without a single known phase. A listed name that is not registered is an error Result.
 */
export async function runChecks(
	pack: Pack,
	state: Omit<ChangeState, "checks">,
	ctx: { root: string; git: Git },
): Promise<Result[]> {
	if (state.phase.kind !== "ok") return [];
	const phaseId = state.phase.id;
	const phase = pack.phases.find((p) => p.id === phaseId);
	if (!phase) return [];
	const checkCtx: CheckContext = { root: ctx.root, change: state.change, git: ctx.git };
	const results: Result[] = [];
	for (const name of phase.checks) {
		const check = getCheck(name);
		if (!check) {
			results.push({ code: "check-unregistered", severity: "error", message: `Check ${name} is not registered` });
			continue;
		}
		results.push(...(await check(checkCtx)));
	}
	return results;
}
