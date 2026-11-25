// Adapter to the pi-subagents executor: finds its service by capability and parses the effective launch facts. Holds no livespec state.

export const SERVICE_KEYS = ["@ttdua/pi-subagents:service", "@gotgenes/pi-subagents:service"] as const;

/** The `source` the executor reports for its own role agent; any other source is a user or project override. */
export const BUILTIN_SOURCE = "builtin";

const CAPABILITIES = ["spawn", "wait", "resume", "abort", "childSession", "getAgentType"] as const;

export type JsonSchema = Readonly<Record<string, unknown>>;

export type SpawnOptionsLike = {
	description: string;
	context: "fresh";
	contextFiles: false;
	thinkingLevel: "low" | "medium" | "high";
	metadata: Record<string, string>;
	skills: { inherit: false; paths: string[] };
	excludeExtensionPackages: string[];
	cwd: string;
	resultSchema: JsonSchema;
};

export type RecordLike = {
	id: string;
	status: string;
	result?: string;
	error?: string;
	/** The question the child ended its turn with (`ask_parent`); the executor reports it as plain text. */
	pendingQuestion?: string;
	structuredResult?: unknown;
	structuredResultError?: "missing" | "invalid";
};

export type SubagentsServiceLike = {
	spawn(type: string, prompt: string, o: SpawnOptionsLike): string;
	wait(id: string, o?: { signal?: AbortSignal }): Promise<RecordLike>;
	resume(id: string, prompt: string): Promise<unknown>;
	abort(id: string): boolean;
	childSession(sessionId: string): { agentId: string; agentType: string; metadata: Readonly<Record<string, string>> } | undefined;
	getAgentType(name: string): { name: string; source: string; filePath?: string } | undefined;
};

/** The effective values the executor reports for a launch, read from `subagents:child:session-created`. */
export type LaunchFacts = {
	context: string;
	cwd: string;
	inheritSkills?: boolean;
	skillPaths?: string[];
	contextFiles?: boolean;
	excludedExtensionPackages?: string[];
	effectiveModel?: string;
	effectiveThinking?: string;
};

export type ExecutorLookup = { ok: true; service: SubagentsServiceLike; key: string } | { ok: false; missing: string[] };

function publishedService(key: string): Record<string, unknown> | undefined {
	const value: unknown = Reflect.get(globalThis, Symbol.for(key));
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function missingCapabilities(service: Record<string, unknown>): string[] {
	return CAPABILITIES.filter((name) => typeof service[name] !== "function");
}

/** The first published service key wins, whatever the implementation is named; it must have every capability. */
export function findExecutor(): ExecutorLookup {
	for (const key of SERVICE_KEYS) {
		const service = publishedService(key);
		if (service === undefined) continue;
		const missing = missingCapabilities(service);
		if (missing.length > 0) return { ok: false, missing };
		return { ok: true, service: service as unknown as SubagentsServiceLike, key };
	}
	return { ok: false, missing: [...CAPABILITIES] };
}

function optionalOf<T>(source: Record<string, unknown>, key: string, check: (value: unknown) => value is T): Partial<Record<string, T>> {
	const value = source[key];
	return check(value) ? { [key]: value } : {};
}

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isString = (v: unknown): v is string => typeof v === "string";
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

/** Pure parse of a `session-created` payload; `undefined` when the payload has no agent id, context or cwd. */
export function parseLaunchFacts(payload: unknown): { agentId: string; facts: LaunchFacts } | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const p = payload as Record<string, unknown>;
	if (!isString(p.agentId) || !isString(p.context) || !isString(p.cwd)) return undefined;
	const facts: LaunchFacts = {
		context: p.context,
		cwd: p.cwd,
		...optionalOf(p, "inheritSkills", isBoolean),
		...optionalOf(p, "skillPaths", isStringArray),
		...optionalOf(p, "contextFiles", isBoolean),
		...optionalOf(p, "excludedExtensionPackages", isStringArray),
		...optionalOf(p, "effectiveModel", isString),
		...optionalOf(p, "effectiveThinking", isString),
	};
	return { agentId: p.agentId, facts };
}
