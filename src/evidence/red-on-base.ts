// The gate-only check `verify-red-on-base`: each unit's `Verify` runs on `Base` in a
// temporary worktree and must be red (green for a refactor unit). A unit whose test
// file is missing on `Base` is verifier pending: a warning, or an error for a refactor.

import type { Unit } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import type { Result } from "../core/result.ts";
import { type CheckContext, gateMemoGeneration, onGateMemoClear, registerCheck } from "../engine/registry.ts";
import { displayUnitId } from "../interaction/display-ids.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { pendingDecision } from "./pending.ts";
import { classifyRun, preExpectation, type RunClass } from "./red-green.ts";
import { runVerify } from "./runner.ts";
import { RECEIPT_OUTPUT_BYTES, type VerifyEnv } from "./verify-env.ts";
import { withTempWorktree } from "./worktree.ts";

const CHECK = "verify-red-on-base";
const NO_SESSION = `${CHECK} cannot run: no livespec session`;
const NO_BASE = `${CHECK} cannot run: the change has no Base`;

type EnvProvider = () => Promise<VerifyEnv | undefined>;
let provider: EnvProvider = async () => undefined;

/** Sets where the check gets its environment; `src/extension.ts` passes the current session's. */
export function setRedOnBaseEnv(next: EnvProvider): void {
	provider = next;
}

/** Results of units already run on `Base`, by `${root}:${base}:${unit}:${digest}`; one session. */
const unitCache = new Map<string, Result[]>();
onGateMemoClear(() => unitCache.clear());

const error = (message: string): Result => ({ code: CHECK, severity: "error", section: "Units", message });
const warning = (message: string): Result => ({ code: CHECK, severity: "warning", section: "Units", message });

/** The registry key: the root, `Base` and every unit with its digest. */
export function redOnBaseKey(ctx: CheckContext): string {
	const units = ctx.change.units.map((u) => `${u.id}:${unitDigest(u)}`).sort();
	return JSON.stringify([ctx.root, ctx.change.header.base ?? "", units]);
}

async function isPending(env: VerifyEnv, base: string, u: Unit): Promise<boolean> {
	const present = new Map<string, boolean>();
	for (const path of u.files) present.set(path, await env.git.pathExistsAt(base, path));
	return pendingDecision(u, (path) => present.get(path) === true);
}

function pendingResult(u: Unit): Result {
	const id = displayUnitId(u.id);
	if (u.kind === "refactor") return error(`${id} is a refactor unit whose test file does not exist on Base: a refactor needs an existing test.`);
	return warning(`${id}: verifier pending (its test file does not exist on Base).`);
}

function classResult(u: Unit, cls: RunClass, exit: number | null, output: string): Result[] {
	const id = displayUnitId(u.id);
	if (typeof cls === "object") return [error(`${id}: Verify could not give a red or green on Base (${cls.invalid}); the command could not run.${tail(output)}`)];
	const expected = preExpectation(u);
	if (cls === expected) return [];
	return [error(`${id}: Verify was ${cls} (exit ${exit}) on Base, but it must be ${expected}.${tail(output)}`)];
}

const tail = (output: string): string => (output === "" ? "" : `\n${untrusted(output)}`);

/** Runs `Verify` of `u` on `base` in a temporary worktree; the result is cacheable unless the run was invalid. */
async function runOnBase(env: VerifyEnv, base: string, u: Unit, verify: string): Promise<{ results: Result[]; cache: boolean }> {
	const id = displayUnitId(u.id);
	const run = { ...env.run, tailBytes: RECEIPT_OUTPUT_BYTES };
	const setup = env.config?.verify?.setup;
	const prep = { ...(setup !== undefined ? { setup } : {}), run };
	const out = await withTempWorktree(env.git, env.root, base, prep, (dir) => runVerify(verify, { ...run, cwd: dir }));
	if ("invalid" in out) return { results: [error(`${id}: the worktree on Base could not be prepared (${out.invalid}).${tail(out.output)}`)], cache: false };
	if ("blocked" in out) return { results: [error(`${id}: the Verify command is blocked, so it was not run: ${untrusted(out.blocked)} Fix Verify with unit_amend.`)], cache: false };
	const cls = classifyRun(out);
	return { results: classResult(u, cls, out.exit, out.output), cache: typeof cls !== "object" };
}

async function checkUnit(env: VerifyEnv, ctx: CheckContext, base: string, u: Unit): Promise<Result[]> {
	if (u.verify === undefined) return [];
	if (await isPending(env, base, u)) return [pendingResult(u)];
	const cacheKey = `${ctx.root}:${base}:${u.id}:${unitDigest(u)}`;
	const cached = unitCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const generation = gateMemoGeneration();
	const { results, cache } = await runOnBase(env, base, u, u.verify);
	// A memo cleared while the run was in flight must not get its results back.
	if (cache && generation === gateMemoGeneration()) unitCache.set(cacheKey, results);
	return results;
}

async function verifyRedOnBase(ctx: CheckContext): Promise<Result[]> {
	const env = await provider();
	if (env === undefined) return [error(NO_SESSION)];
	const base = ctx.change.header.base;
	if (base === undefined) return [error(NO_BASE)];
	const results: Result[] = [];
	for (const u of ctx.change.units) results.push(...(await checkUnit(env, ctx, base, u)));
	return results;
}

/** Registers the check; also called by tests after `resetRegistryForTests`. */
export function registerRedOnBase(): void {
	registerCheck(CHECK, verifyRedOnBase, { waivable: true, at: "gate", key: redOnBaseKey });
}

registerRedOnBase();
