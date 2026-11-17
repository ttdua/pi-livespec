// The evidence lock (design D10 "Serialization"): one stable promise chain for the
// session's process, so two `unit_start`/`unit_finish` calls never decide from the
// same stale state. It needs no key: a refresh inside the lock may switch the change,
// and a key read before that refresh could put two calls on different chains.

let tail: Promise<void> | undefined;

/** Runs `fn` after every earlier evidence call has settled; a failure does not break the chain. */
export function withEvidenceLock<T>(fn: () => Promise<T>): Promise<T> {
	const run = (tail ?? Promise.resolve()).then(fn);
	const next = run.then(
		() => undefined,
		() => undefined,
	);
	tail = next;
	void next.then(() => {
		if (tail === next) tail = undefined;
	});
	return run;
}

/** Resolves once no evidence call is queued or running, including calls queued while waiting. */
export async function drainEvidenceLocks(): Promise<void> {
	while (tail !== undefined) await tail;
}
