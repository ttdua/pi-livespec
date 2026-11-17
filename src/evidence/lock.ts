// The per-process evidence lock (design D10 "Serialization"): one promise chain per
// issue, so two `unit_start`/`unit_finish` calls never decide from the same stale state.

const chains = new Map<number, Promise<void>>();

/** Runs `fn` after every earlier call for `issue` has settled; a failure does not break the chain. */
export function withEvidenceLock<T>(issue: number, fn: () => Promise<T>): Promise<T> {
	const previous = chains.get(issue) ?? Promise.resolve();
	const run = previous.then(fn);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	chains.set(issue, tail);
	void tail.then(() => {
		if (chains.get(issue) === tail) chains.delete(issue);
	});
	return run;
}

/** Resolves once no evidence call is queued or running, including calls queued while waiting. */
export async function drainEvidenceLocks(): Promise<void> {
	while (chains.size > 0) await Promise.all(chains.values());
}
