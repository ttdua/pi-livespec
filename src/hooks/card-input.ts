// Builds the phase card input from the session: pack, forge, branch and change
// state. Forge and git errors propagate; `Session.refresh` turns them into a
// degraded card.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TEMPLATE_MARKER } from "../core/templates.ts";
import { runChecks } from "../engine/checks.ts";
import { nextStep } from "../engine/next-step.ts";
import type { Pack } from "../engine/pack-types.ts";
import { resolveChange } from "../engine/resolve-change.ts";
import { readChangeSnapshot } from "../engine/snapshot.ts";
import { readUnfamiliar } from "../subagents/unfamiliar.ts";
import type { ChangeState, NextStep } from "../engine/state-types.ts";
import { isOffline } from "../forge/errors.ts";
import type { CardAccount, CardInput } from "./phase-card.ts";
import type { Session } from "./session.ts";

const CONSTRAINTS_FILE = ["specs", "constraints.md"];
const FORGE_NOT_CONNECTED = "the forge is not connected";

type Common = Pick<CardInput, "first" | "constraintsTemplate" | "unnotedSkills" | "account">;

/** The account part of the card: the pending notice and the write block; `undefined` when neither is set. */
export function cardAccount(session: Session): CardAccount | undefined {
	const { accountNotice: line, accountBlock: blocked } = session;
	if (line === undefined && blocked === undefined) return undefined;
	return { ...(line !== undefined ? { line } : {}), ...(blocked !== undefined ? { blocked } : {}) };
}

/** Whether `specs/constraints.md` still begins with the init template marker. A missing file is not a template. */
export async function constraintsTemplate(root: string): Promise<boolean> {
	try {
		const text = await readFile(join(root, ...CONSTRAINTS_FILE), "utf8");
		return text.split(/\r?\n/, 1)[0]?.trim() === TEMPLATE_MARKER;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Optional skills of the active phase read in this session without a `<phase>.<skill>` note. */
function unnotedSkills(session: Session, step: NextStep, state: ChangeState): string[] {
	if (step.phase === undefined) return [];
	const noted = new Set(state.skillNotes);
	return step.optional.filter((skill) => session.skillReads.has(skill) && !noted.has(`${step.phase}.${skill}`));
}


type Resolved = { kind: "change"; number: number; warning?: string } | Exclude<CardInput, { kind: "change" }>;

/**
 * Resolves the change of the current branch. While the forge is offline the search cannot run, so the
 * change last resolved for this branch is reused and its snapshot comes from the cache.
 */
async function resolve(session: Session, common: Common, branch: string): Promise<Resolved> {
	const forge = session.forge;
	if (forge === undefined) return { ...common, kind: "forge-unavailable", message: session.forgeError ?? FORGE_NOT_CONNECTED };
	try {
		const r = await resolveChange(forge, branch);
		if (r.kind === "error") return { ...common, kind: "change-error", message: r.message };
		if (r.kind === "none") return { ...common, kind: "list", open: r.open };
		session.lastResolved = { branch, number: r.number };
		return r;
	} catch (error) {
		const last = session.lastResolved;
		if (isOffline(error) && last?.branch === branch) return { kind: "change", number: last.number };
		throw error;
	}
}

async function changeState(session: Session, pack: Pack, n: number, warning: string | undefined): Promise<ChangeState> {
	const forge = session.forge;
	const comments = session.comments;
	if (forge === undefined || comments === undefined) throw new Error(FORGE_NOT_CONNECTED);
	const caps = { iterations: pack.loops.change_iterations, unitAttempts: pack.loops.unit_attempts };
	const snapshot = await readChangeSnapshot({ forge, isReadOnly: () => forge.isReadOnly(), git: session.git, comments, caps }, n);
	const checks = await runChecks(pack, snapshot, { root: session.cwd, git: session.git });
	const warnings = warning === undefined ? snapshot.warnings : [warning, ...snapshot.warnings];
	const phase = snapshot.phase.kind === "ok" ? snapshot.phase.id : "";
	const unfamiliar = await readUnfamiliar(session.cwd, phase, snapshot.change);
	const subagents = { ...snapshot.subagents, ...session.mainTurns, unfamiliar };
	return { ...snapshot, subagents, checks, warnings, commandWarnings: [...session.commandWarnings] };
}

export async function buildCardInput(d: { session: Session; first: boolean }): Promise<CardInput> {
	const { session, first } = d;
	const common: Common = { first, constraintsTemplate: await constraintsTemplate(session.cwd), unnotedSkills: [], account: cardAccount(session) };
	if (!session.pack.ok) return { ...common, kind: "pack-errors", errors: session.pack.errors };
	const pack = session.pack.pack;
	const resolved = await resolve(session, common, await session.git.branch());
	if (resolved.kind !== "change") return resolved;
	const state = await changeState(session, pack, resolved.number, resolved.warning);
	const step = nextStep(pack, state);
	return { ...common, unnotedSkills: unnotedSkills(session, step, state), kind: "change", step, state };
}
