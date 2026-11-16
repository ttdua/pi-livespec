// Project and user config files. Unknown keys and invalid values become
// warnings, never errors. `detectForge` keeps its own reader.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { ADAPTER_NAMES, type AdapterName } from "./interaction/approver.ts";

export type Channel = "auto" | "notify" | "pinned";
export const DEFAULT_CHANNEL: Channel = "auto";
const CHANNELS: readonly string[] = ["auto", "notify", "pinned"];
const FORGES: readonly string[] = ["github", "gitea"];

export interface ProjectConfig {
	forge?: "github" | "gitea";
	host?: string;
	githubHosts: string[];
	giteaUrl?: string;
	integrationBranch?: string;
	agentSkillsChannelSet: boolean;
	interaction?: InteractionConfig;
}

export interface InteractionConfig {
	adapter: AdapterName[];
}

export interface UserConfig {
	agentSkills: { channel: Channel };
	interaction?: InteractionConfig;
}

export interface LoadedConfig {
	project: ProjectConfig | null;
	user: UserConfig;
	warnings: string[];
}

const PROJECT_KEYS = ["forge", "host", "githubHosts", "giteaUrl", "integrationBranch", "agentSkills", "interaction"];
const USER_KEYS = ["agentSkills", "interaction"];
const DEFAULT_CHAIN: readonly AdapterName[] = ["in-session"];
const ADAPTERS: readonly string[] = ADAPTER_NAMES;

type Doc = Record<string, unknown>;

interface ReadResult {
	exists: boolean;
	doc: Doc;
}

async function readDoc(file: string, warnings: string[]): Promise<ReadResult> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, doc: {} };
		warnings.push(`${file}: cannot read (${(error as Error).message}); using defaults`);
		return { exists: true, doc: {} };
	}
	let value: unknown;
	try {
		value = parse(text);
	} catch (error) {
		warnings.push(`${file}: invalid YAML (${(error as Error).message.split("\n")[0]}); using defaults`);
		return { exists: true, doc: {} };
	}
	if (value === null || value === undefined) return { exists: true, doc: {} };
	if (typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`${file}: expected a mapping at the top level; using defaults`);
		return { exists: true, doc: {} };
	}
	return { exists: true, doc: value as Doc };
}

/** Formats an untrusted YAML value for a warning without calling its methods. */
function describeValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return `${value}`;
	if (Array.isArray(value)) return "a list";
	if (value !== null && typeof value === "object") return "a mapping";
	return "null";
}

function warnUnknownKeys(file: string, doc: Doc, known: string[], warnings: string[]): void {
	for (const key of Object.keys(doc)) {
		if (!known.includes(key)) warnings.push(`${file}: unknown key "${key}"`);
	}
}

function optionalString(file: string, doc: Doc, key: string, warnings: string[]): string | undefined {
	const value = doc[key];
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	warnings.push(`${file}: "${key}" must be a string; ignored`);
	return undefined;
}

function stringList(file: string, doc: Doc, key: string, warnings: string[]): string[] {
	const value = doc[key];
	if (value === undefined) return [];
	if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
	warnings.push(`${file}: "${key}" must be a list of strings; ignored`);
	return [];
}

/** The `agentSkills.channel` entry: whether it is set, and its value when valid. */
function readChannel(file: string, doc: Doc, warnings: string[]): { set: boolean; channel?: Channel } {
	const section = doc.agentSkills;
	if (section === undefined) return { set: false };
	if (section === null || typeof section !== "object" || Array.isArray(section)) {
		warnings.push(`${file}: "agentSkills" must be a mapping; ignored`);
		return { set: false };
	}
	const entry = section as Doc;
	for (const key of Object.keys(entry)) {
		if (key !== "channel") warnings.push(`${file}: unknown key "agentSkills.${key}"`);
	}
	if (entry.channel === undefined) return { set: false };
	if (typeof entry.channel === "string" && CHANNELS.includes(entry.channel)) {
		return { set: true, channel: entry.channel as Channel };
	}
	warnings.push(
		`${file}: invalid agentSkills.channel "${describeValue(entry.channel)}" (expected auto, notify or pinned); using ${DEFAULT_CHANNEL}`,
	);
	return { set: true };
}

/** The `interaction` section: `adapter` must be a list of adapter names; unknown names are dropped. */
function readInteraction(file: string, doc: Doc, warnings: string[]): InteractionConfig | undefined {
	const section = doc.interaction;
	if (section === undefined) return undefined;
	if (section === null || typeof section !== "object" || Array.isArray(section)) {
		warnings.push(`${file}: "interaction" must be a mapping; ignored`);
		return undefined;
	}
	const entry = section as Doc;
	for (const key of Object.keys(entry)) {
		if (key !== "adapter") warnings.push(`${file}: unknown key "interaction.${key}"`);
	}
	if (entry.adapter === undefined) return undefined;
	if (!Array.isArray(entry.adapter)) {
		warnings.push(`${file}: "interaction.adapter" must be a list of adapter names (in-session, forge); ignored`);
		return undefined;
	}
	const adapter: AdapterName[] = [];
	for (const name of entry.adapter as unknown[]) {
		if (typeof name === "string" && ADAPTERS.includes(name)) adapter.push(name as AdapterName);
		else warnings.push(`${file}: unknown adapter "${describeValue(name)}" in interaction.adapter (expected in-session or forge); dropped`);
	}
	return { adapter };
}

function buildProject(file: string, doc: Doc, warnings: string[]): ProjectConfig {
	warnUnknownKeys(file, doc, PROJECT_KEYS, warnings);
	const project: ProjectConfig = { githubHosts: stringList(file, doc, "githubHosts", warnings), agentSkillsChannelSet: false };
	if (typeof doc.forge === "string" && FORGES.includes(doc.forge)) project.forge = doc.forge as "github" | "gitea";
	else if (doc.forge !== undefined) warnings.push(`${file}: invalid forge "${describeValue(doc.forge)}" (expected github or gitea); ignored`);
	const host = optionalString(file, doc, "host", warnings);
	if (host !== undefined) project.host = host;
	const giteaUrl = optionalString(file, doc, "giteaUrl", warnings);
	if (giteaUrl !== undefined) project.giteaUrl = giteaUrl;
	const branch = optionalString(file, doc, "integrationBranch", warnings);
	if (branch !== undefined) project.integrationBranch = branch;
	project.agentSkillsChannelSet = readChannel(file, doc, warnings).set;
	const interaction = readInteraction(file, doc, warnings);
	if (interaction !== undefined) project.interaction = interaction;
	return project;
}

function buildUser(file: string, doc: Doc, warnings: string[]): UserConfig {
	warnUnknownKeys(file, doc, USER_KEYS, warnings);
	const user: UserConfig = { agentSkills: { channel: readChannel(file, doc, warnings).channel ?? DEFAULT_CHANNEL } };
	const interaction = readInteraction(file, doc, warnings);
	if (interaction !== undefined) user.interaction = interaction;
	return user;
}

/** Reads `<root>/.pi/livespec/config.yaml` and `<home>/.pi/agent/livespec/config.yaml`. `project === null` means not initialized. */
export async function loadConfig(root: string, home: string): Promise<LoadedConfig> {
	const warnings: string[] = [];
	const projectPath = join(root, ".pi", "livespec", "config.yaml");
	const userPath = join(home, ".pi", "agent", "livespec", "config.yaml");
	const projectFile = await readDoc(projectPath, warnings);
	const userFile = await readDoc(userPath, warnings);
	return {
		project: projectFile.exists ? buildProject(projectPath, projectFile.doc, warnings) : null,
		user: buildUser(userPath, userFile.doc, warnings),
		warnings,
	};
}

export type ChainSource = "project" | "user" | "default";

/**
 * The ordered adapter chain: the first non-empty list of project, then user.
 * An empty list (written empty, or empty after unknown names were dropped on
 * load) counts as unset. When neither layer has a non-empty list, the chain is
 * `[in-session]` with source `default`.
 */
export function adapterChain(config: LoadedConfig): { chain: AdapterName[]; source: ChainSource } {
	const projectList = config.project?.interaction?.adapter ?? [];
	if (projectList.length > 0) return { chain: [...projectList], source: "project" };
	const userList = config.user.interaction?.adapter ?? [];
	if (userList.length > 0) return { chain: [...userList], source: "user" };
	return { chain: [...DEFAULT_CHAIN], source: "default" };
}
