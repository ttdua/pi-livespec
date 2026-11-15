// Built-in `/livespec doctor` checks. Each one only reads, through `DoctorDeps`
// or read-only helpers, and returns results; none of them writes.

import { join, sep } from "node:path";
import { loadConfig } from "../config.ts";
import { checkCompat } from "../content/compat.ts";
import { readLock } from "../content/lock.ts";
import { packSkillNames } from "../content/pack-skills.ts";
import { contentPaths } from "../content/paths.ts";
import { ForgeError } from "../forge/errors.ts";
import type { DoctorCheck, DoctorDeps, DoctorResult } from "./doctor.ts";
import { formatPackError, messageOf } from "./messages.ts";

const SUPERPOWERS_SKILL = "using-superpowers";
const SUPERPOWERS_OVERRIDE = '{"packages":[{"source":"<superpowers source>","skills":[],"extensions":[]}]}';
const STAGING_PREFIX = ".staging-";
const OPENSPEC_DIR = "openspec";

const ok = (id: string, message: string): DoctorResult => ({ id, status: "ok", message });
const warn = (id: string, message: string, suggestion?: string): DoctorResult =>
	suggestion === undefined ? { id, status: "warn", message } : { id, status: "warn", message, suggestion };
const error = (id: string, message: string, suggestion?: string): DoctorResult =>
	suggestion === undefined ? { id, status: "error", message } : { id, status: "error", message, suggestion };

export const checkPack: DoctorCheck = async (d) => {
	if (!d.pack.ok) return d.pack.errors.map((e) => error("pack", formatPackError(e)));
	return [ok("pack", `flow pack ${d.pack.pack.name} is valid`), ...d.pack.warnings.map((e) => warn("pack", formatPackError(e)))];
};

export const checkConfig: DoctorCheck = async (d) => {
	const config = await loadConfig(d.root, d.home);
	const results = config.warnings.map((w) => warn("config", w));
	if (config.project?.agentSkillsChannelSet) {
		results.push(
			warn(
				"config",
				"the project config sets agentSkills.channel, which is ignored: the channel is read from the user config only, because the clone is shared by all projects",
				"move agentSkills.channel to ~/.pi/agent/livespec/config.yaml",
			),
		);
	}
	return results.length > 0 ? results : [ok("config", "config files are valid")];
};

export const checkOpenSpec: DoctorCheck = async (d) => {
	if (d.initialized || !(await d.exists(join(d.root, OPENSPEC_DIR)))) return [ok("openspec", "no OpenSpec folder to migrate")];
	return [warn("openspec", "the project is not initialized and has an openspec/ folder", "run /livespec migrate-openspec")];
};

export const checkClone: DoctorCheck = async (d) => {
	const paths = contentPaths(d.home);
	const stagingDirs = (await d.listDir(paths.root)).filter((name) => name.startsWith(STAGING_PREFIX));
	const staging = stagingDirs.map((name) =>
		warn("clone", `leftover staging directory ${join(paths.root, name)}`, "remove it when no session is changing agent-skills"),
	);
	if ((await d.content.activeTree()) === undefined) {
		return [error("clone", "agent-skills is not cloned", "run /livespec init"), ...staging];
	}
	const lock = await readLock(paths.lock);
	if (!lock) return [error("clone", `agent-skills has no lock file at ${paths.lock}`, "run /livespec skills update"), ...staging];
	const pin = lock.pinned === null ? "not pinned" : `pinned ${lock.pinned}`;
	return [ok("clone", `agent-skills commit ${lock.commit}, ${pin}, last check ${lock.checkedAt ?? "never"}`), ...staging];
};

/** The compatibility check of the active tree: every pack skill valid, every persona present. Read-only. */
export const checkPackSkills: DoctorCheck = async (d) => {
	const tree = await d.content.activeTree();
	if (!d.pack.ok || tree === undefined) return [];
	const compat = await checkCompat(tree, d.pack.pack);
	if (compat.ok) return [ok("pack-skills", "every pack skill is in the clone")];
	return compat.failures.map((f) =>
		error("pack-skills", `pack item ${f.item} is missing or invalid in the clone: ${f.reason}`, "run /livespec skills update"),
	);
};

export const checkDuplicateSkills: DoctorCheck = async (d) => {
	if (!d.pack.ok) return [];
	const tree = await d.content.activeTree();
	const inClone = (path: string) => tree !== undefined && path.startsWith(tree + sep);
	const names = new Set(packSkillNames(d.pack.pack));
	const shadowed = d.loadedSkills.filter((s) => names.has(s.name) && !inClone(s.filePath));
	if (shadowed.length === 0) return [ok("duplicate-skills", "no loaded skill shadows a pack skill")];
	return shadowed.map((s) =>
		warn(
			"duplicate-skills",
			`skill ${s.name} is loaded from ${s.filePath}, outside the agent-skills clone; pi keeps the first skill found`,
			`remove or rename ${s.filePath} to use the pack's ${s.name}`,
		),
	);
};

export const checkSuperpowers: DoctorCheck = async (d) => {
	if (!d.loadedSkills.some((s) => s.name === SUPERPOWERS_SKILL)) return [ok("superpowers", "Superpowers is not active")];
	const override = `to turn Superpowers off in this project, add to .pi/settings.json: ${SUPERPOWERS_OVERRIDE}`;
	const suggestion = d.isTrusted
		? override
		: `${override}. The override needs a trusted project, and this project is not trusted: run /trust`;
	return [warn("superpowers", "Superpowers is active in this project and competes with the livespec flow", suggestion)];
};

export const checkForge: DoctorCheck = async (d) => {
	let connection: Awaited<ReturnType<DoctorDeps["forge"]>>;
	try {
		connection = await d.forge();
	} catch (e) {
		return [error("forge", `forge detection failed: ${messageOf(e)}`, "check the origin remote and .pi/livespec/config.yaml")];
	}
	let login: string;
	try {
		login = (await connection.forge.whoami()).login;
	} catch (e) {
		return [forgeFailure(e)];
	}
	if (connection.readOnly) return [warn("forge", `${connection.forge.kind} is in read-only mode: the forge was unreachable`)];
	return [ok("forge", `${connection.forge.kind} as ${login}`)];
};

function forgeFailure(e: unknown): DoctorResult {
	if (e instanceof ForgeError && e.code === "auth") {
		return error("forge", `forge authentication failed: ${e.message}`, "log in with gh or tea");
	}
	if (e instanceof ForgeError && e.code === "unreachable") {
		return warn("forge", `the forge is unreachable, so livespec runs in read-only mode: ${e.message}`);
	}
	return error("forge", `forge check failed: ${messageOf(e)}`);
}

/** Built-in checks in report order; registered checks run after them. */
export const BUILTIN_CHECKS: readonly { id: string; run: DoctorCheck }[] = [
	{ id: "pack", run: checkPack },
	{ id: "config", run: checkConfig },
	{ id: "openspec", run: checkOpenSpec },
	{ id: "clone", run: checkClone },
	{ id: "pack-skills", run: checkPackSkills },
	{ id: "duplicate-skills", run: checkDuplicateSkills },
	{ id: "superpowers", run: checkSuperpowers },
	{ id: "forge", run: checkForge },
];
