// Built-in named checks over the LS-02 validators, and the runner for the
// checks the active phase lists. Later specs add checks through registerCheck.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { capabilitiesMatchDiff } from "../core/capabilities-diff.ts";
import type { Change } from "../core/change.ts";
import { messageOf } from "../core/messages.ts";
import type { Result } from "../core/result.ts";
import { parseSpec } from "../core/spec.ts";
import { validateSpec } from "../core/validate-spec.ts";
import { checkDoneMapsScenarios, validateUnits } from "../core/validate-units.ts";
import { type Git, GitError } from "./git.ts";
import type { Pack } from "./pack-types.ts";
import { type CheckContext, type CheckFn, getCheck, registerCheck } from "./registry.ts";
import type { ChangeState, CheckResult } from "./state-types.ts";

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
		return [errorResult("file-unreadable", file, messageOf(e))];
	}
	try {
		return validateSpec(parseSpec(text, capability), file);
	} catch (e) {
		return [errorResult("file-parse", file, messageOf(e))];
	}
}

/** `spec-format`: the living specs of the capabilities the change declares, and no others. */
const specFormat: CheckFn = async ({ root, change }) => {
	const results: Result[] = [];
	for (const capability of declaredCapabilities(change)) results.push(...(await validateCapability(root, capability)));
	return results;
};

/**
 * `capabilities-match-diff`: the declared line against `git diff <Base>..HEAD -- specs/`.
 * A Base git cannot diff from (e.g. not fetched) is an error Result, not a throw.
 */
const capabilitiesMatch: CheckFn = async ({ change, git }) => {
	const base = change.header.base;
	if (base === undefined) return capabilitiesMatchDiff(change, "");
	try {
		return capabilitiesMatchDiff(change, await git.diff(base, "HEAD", SPECS_PATH));
	} catch (error) {
		if (!(error instanceof GitError)) throw error;
		const detail = error.stderr.trim() || error.message;
		return [{ code: "capabilities-match-diff", severity: "error", section: "Capabilities", message: `cannot diff specs/ from Base ${base}: ${detail}` }];
	}
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

/** Runs one named check; an unregistered name or a check that throws becomes an error Result. */
async function runOne(name: string, ctx: CheckContext): Promise<Result[]> {
	const check = getCheck(name);
	if (!check) return [{ code: "check-unregistered", severity: "error", message: `Check ${name} is not registered` }];
	try {
		return await check(ctx);
	} catch (error) {
		return [{ code: "check-failed", severity: "error", message: `Check ${name} failed: ${messageOf(error)}` }];
	}
}

/**
 * Runs the checks the active phase lists, in pack order, and concatenates their results.
 * Each result is tagged with the name of the check that produced it. No check runs without a single
 * known phase. A listed name that is not registered, or a check that throws, is an error Result.
 */
export async function runChecks(
	pack: Pack,
	state: Omit<ChangeState, "checks">,
	ctx: { root: string; git: Git },
): Promise<CheckResult[]> {
	if (state.phase.kind !== "ok") return [];
	const phaseId = state.phase.id;
	const phase = pack.phases.find((p) => p.id === phaseId);
	if (!phase) return [];
	const checkCtx: CheckContext = { root: ctx.root, change: state.change, git: ctx.git };
	const results: CheckResult[] = [];
	for (const name of phase.checks) {
		const produced = await runOne(name, checkCtx);
		// The registered name is applied last, so a result cannot claim another check's name.
		for (const result of produced) results.push({ ...result, check: name });
	}
	return results;
}
