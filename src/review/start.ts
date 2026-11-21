// The start stage's inputs (design D2 step 1): every unit's `Verify` at HEAD, the diff's files, the re-checked tags
// and the `constraints-not-weakened` findings. Reads git and runs commands; writes nothing.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Unit } from "../core/change.ts";
import type { Pack } from "../engine/pack-types.ts";
import { diffFilesOf } from "../engine/git.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { classifyRun } from "../evidence/red-green.ts";
import { runVerify, type VerifyRun as RunnerResult } from "../evidence/runner.ts";
import { RECEIPT_OUTPUT_BYTES, type VerifyEnv } from "../evidence/verify-env.ts";
import type { Finding } from "../subagents/roles.ts";
import type { ReviewRunData, VerifyRun } from "./records.ts";
import { retag } from "./retag.ts";
import { checkStandards } from "./standards.ts";

export type StartInputs = { verify: ReviewRunData["verify"]; parent: Finding[]; diffFiles: string[]; tags: string[] };
export type StartCtx = { state: ChangeState; pack: Pack; env: VerifyEnv };

/** The evidence keeps the end of the output: enough to see the failure without flooding the aggregate. */
const EVIDENCE_TAIL_CHARS = 2000;
const CONSTRAINTS = join("specs", "constraints.md");

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function verdictOf(run: RunnerResult): VerifyRun["verdict"] {
	const cls = classifyRun(run);
	return typeof cls === "object" ? "invalid" : cls;
}

/** A `CRITICAL` `defect` parent finding at `<first File>:1` for each red or invalid run, with the output tail. */
export function unitVerifyFindings(runs: { unit: Unit; run: RunnerResult }[]): Finding[] {
	return runs.flatMap(({ unit, run }) => {
		const verdict = verdictOf(run);
		if (verdict === "green") return [];
		const tail = run.output.slice(-EVIDENCE_TAIL_CHARS);
		return [{
			severity: "CRITICAL", kind: "defect", location: `${unit.files[0] ?? unit.id}:1`, scope: "unit",
			evidence: `Verify of ${unit.id} was ${verdict} (exit ${run.exit ?? "none"}) at HEAD.\n${tail}`,
			fix: `Make ${unit.id}'s Verify pass again at HEAD.`,
		} satisfies Finding];
	});
}

/** Every unit's guard decision first, so a blocked command refuses before anything runs. */
function guardRefusal(env: VerifyEnv, units: Unit[]): string | undefined {
	for (const u of units) {
		const blocked = env.run.guard(u.verify ?? "");
		if (blocked !== undefined) return `the Verify command of ${u.id} is blocked by the guard, so nothing was run: ${blocked} Fix Verify with unit_amend.`;
	}
	return undefined;
}

/** Runs every unit's `Verify` at HEAD in body order; a cancelled run refuses. */
async function runUnits(env: VerifyEnv, units: Unit[]): Promise<{ unit: Unit; run: RunnerResult }[] | { refused: string }> {
	const runs: { unit: Unit; run: RunnerResult }[] = [];
	for (const unit of units) {
		const run = await runVerify(unit.verify ?? "", { ...env.run, cwd: env.root, tailBytes: RECEIPT_OUTPUT_BYTES });
		if ("blocked" in run) return { refused: `the Verify command of ${unit.id} is blocked by the guard: ${run.blocked}` };
		if (run.aborted) return { refused: "the call was cancelled while Verify ran; nothing was written." };
		runs.push({ unit, run });
	}
	return runs;
}

/** The start stage's inputs, in order: Verify runs, diff files, re-checked tags, standards; or why the stage refuses. */
export async function startInputs(ctx: StartCtx): Promise<StartInputs | { refused: string }> {
	const { state, pack, env } = ctx;
	const base = state.change.header.base;
	if (base === undefined) return { refused: "the change has no Base line, so the review diff is unknown." };
	const units = state.change.units;
	const blocked = guardRefusal(env, units);
	if (blocked !== undefined) return { refused: blocked };
	const runs = await runUnits(env, units);
	if ("refused" in runs) return runs;
	let diffFiles: string[];
	let diff: string;
	try {
		diffFiles = diffFilesOf(await env.git.diffNameStatus(base, "HEAD"));
		diff = await env.git.diff(base, "HEAD", ".");
	} catch (error) {
		return { refused: `git diff ${base}..HEAD failed: ${messageOf(error)}` };
	}
	const verify = Object.fromEntries(runs.map(({ unit, run }) => [unit.id, { exit: run.exit, verdict: verdictOf(run) }]));
	const standards = checkStandards(diff, { constraintsCited: existsSync(join(env.root, CONSTRAINTS)) });
	return { verify, parent: [...unitVerifyFindings(runs), ...standards], diffFiles, tags: retag(pack, state, diffFiles) };
}
