// A fake pi-subagents service for dispatch tests: records spawn options, emits `session-created` on a bus, resolves waits with scripted records.

import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { LaunchFacts, RecordLike, SpawnOptionsLike } from "../../src/subagents/executor.ts";
import { SESSION_CREATED } from "../../src/subagents/launch.ts";

export const SERVICE_KEY = Symbol.for("@ttdua/pi-subagents:service");

export type Spawned = { type: string; prompt: string; options: SpawnOptionsLike; id: string };

export type FakeExecutorOptions = {
	/** The settled records, in order, one per wait. */
	records?: Partial<RecordLike>[];
	/** Facts the executor reports; by default the request is applied as asked. `null` emits no event. */
	facts?: (o: SpawnOptionsLike) => Partial<LaunchFacts> | null;
	/** Emit `session-created` synchronously inside `spawn` (the race) instead of after it. */
	emitDuringSpawn?: boolean;
	agent?: { name: string; source: string; filePath?: string } | null;
	spawnError?: string;
	resumeRefused?: boolean;
	/** Ids `getRecord` knows; by default every spawned id. */
	unknownIds?: string[];
	/** Every wait settles only when its signal aborts (rejecting), as a long run the user cancels. */
	holdUntilAborted?: boolean;
};

export function applied(o: SpawnOptionsLike): LaunchFacts {
	return { context: o.context, cwd: o.cwd, inheritSkills: o.skills.inherit, skillPaths: [...o.skills.paths], contextFiles: o.contextFiles, excludedExtensionPackages: [...o.excludeExtensionPackages] };
}

export function fakeExecutor(o: FakeExecutorOptions = {}) {
	const events = createEventBus();
	const spawned: Spawned[] = [];
	const resumed: { id: string; prompt: string }[] = [];
	const aborted: string[] = [];
	/** `spawn:<id>` and `settled:<id>` in the order they happened. */
	const log: string[] = [];
	const records = [...(o.records ?? [])];
	let n = 0;
	const emit = (id: string, opts: SpawnOptionsLike): void => {
		const facts = o.facts ? o.facts(opts) : applied(opts);
		if (facts === null) return;
		events.emit(SESSION_CREATED, { agentId: id, sessionId: `s-${id}`, ...applied(opts), ...facts });
	};
	const nextRecord = (id: string): RecordLike => ({ id, status: "completed", ...(records.shift() ?? {}) });
	const service = {
		implementation: "@ttdua/pi-subagents",
		spawn(type: string, prompt: string, options: SpawnOptionsLike): string {
			if (o.spawnError) throw new Error(o.spawnError);
			const id = `agent-${++n}`;
			spawned.push({ type, prompt, options, id });
			log.push(`spawn:${id}`);
			if (o.emitDuringSpawn) emit(id, options);
			else queueMicrotask(() => emit(id, options));
			return id;
		},
		async wait(id: string, w?: { signal?: AbortSignal }): Promise<RecordLike> {
			if (o.holdUntilAborted) {
				await new Promise((_resolve, reject) => w?.signal?.addEventListener("abort", () => reject(new Error(`wait for ${id} aborted`)), { once: true }));
			}
			await new Promise((r) => setTimeout(r, 5));
			log.push(`settled:${id}`);
			return nextRecord(id);
		},
		async resume(id: string, prompt: string): Promise<unknown> {
			resumed.push({ id, prompt });
			return o.resumeRefused ? { kind: "refused", reason: "not-resumable" } : { kind: "resumed" };
		},
		abort(id: string): boolean {
			aborted.push(id);
			return true;
		},
		childSession: () => undefined,
		getAgentType: (name: string) => (o.agent === null ? undefined : (o.agent ?? { name, source: "builtin" })),
		getRecord: (id: string) => ((o.unknownIds ?? []).includes(id) ? undefined : { id }),
	};
	return { service, events, spawned, resumed, aborted, records, log };
}

export function publish(service: unknown, key: symbol = SERVICE_KEY): void {
	Reflect.set(globalThis, key, service);
}

export function unpublish(): void {
	Reflect.deleteProperty(globalThis, SERVICE_KEY);
	Reflect.deleteProperty(globalThis, Symbol.for("@gotgenes/pi-subagents:service"));
}

export const done = (over: Record<string, unknown> = {}) => ({ status: "DONE", notes: "n", discoveries: [], sources_used: [], commits: [], ...over });
