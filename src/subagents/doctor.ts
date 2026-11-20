// The subagent doctor checks: the executor and its missing capabilities, overridden role agents, workspace provider packages and the isolation list.

import { type DoctorCheck, type DoctorResult, registerDoctorCheck } from "../commands/doctor.ts";
import { BUILTIN_SOURCE, findExecutor, SERVICE_KEYS, type SubagentsServiceLike } from "./executor.ts";
import { configuredPackages, excludedPackages } from "./isolation.ts";
import { AGENT_OF } from "./roles.ts";

const ID = "subagents";
const INLINE = "livespec runs every role inline";
const INSTALL = "install pi-jev-pilot >= 0.5.0 or the standalone pi-subagents to dispatch roles to subagents";

/** Packages known to register a workspace provider that moves subagent children out of livespec's lanes. */
export const WORKSPACE_PROVIDER_PACKAGES: readonly string[] = ["npm:@gotgenes/pi-subagents-worktrees"];

const isPublished = (): boolean => SERVICE_KEYS.some((key) => Reflect.get(globalThis, Symbol.for(key)) !== undefined);

/** The executor result, plus its service when every capability is present. */
function executorResult(): { result: DoctorResult; service?: SubagentsServiceLike } {
	const found = findExecutor();
	if (found.ok) return { result: { id: "subagent-executor", status: "ok", message: `subagent executor found at ${found.key}` }, service: found.service };
	const message = isPublished() ? `the subagent executor lacks capabilities (missing: ${found.missing.join(", ")}); ${INLINE}` : `no subagent executor is published; ${INLINE}`;
	return { result: { id: "subagent-executor", status: "warn", message, suggestion: INSTALL } };
}

/** One information line per role agent whose effective source is not the executor's built-in. */
function roleOverrides(service: SubagentsServiceLike): DoctorResult[] {
	const results: DoctorResult[] = [];
	for (const name of Object.values(AGENT_OF)) {
		const agent = service.getAgentType(name);
		if (agent === undefined || agent.source === BUILTIN_SOURCE) continue;
		results.push({ id: "subagent-role", status: "ok", message: `${name} is overridden by ${agent.filePath ?? `a ${agent.source} agent`}` });
	}
	return results;
}

function workspaceProviders(configured: string[]): DoctorResult[] {
	return configured
		.filter((source) => WORKSPACE_PROVIDER_PACKAGES.includes(source))
		.map((source) => ({
			id: "subagent-workspace-provider",
			status: "warn",
			message: `${source} registers a workspace provider; a lane child it moves runs its unit sequentially`,
			suggestion: `remove ${source} from pi settings to keep livespec lanes parallel`,
		}));
}

function isolationList(configured: string[], extra: string[]): DoctorResult {
	const excluded = excludedPackages(configured, extra);
	return { id: "subagent-isolation", status: "ok", message: `packages excluded from livespec children: ${excluded.length === 0 ? "none" : excluded.join(", ")}` };
}

export const checkSubagents: DoctorCheck = async (d) => {
	const executor = executorResult();
	const configured = await configuredPackages(d.root, d.home);
	return [
		executor.result,
		...(executor.service === undefined ? [] : roleOverrides(executor.service)),
		...workspaceProviders(configured),
		isolationList(configured, d.config.user.isolation.excludePackages),
	];
};

registerDoctorCheck(ID, checkSubagents);
