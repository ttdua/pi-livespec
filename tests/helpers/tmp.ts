import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

/**
 * Points `TMPDIR` at a fresh directory for each test in the calling scope, so temp dirs created by
 * concurrent runs on the same host (for example `livespec-verify-*`) cannot fail a leftover check.
 */
export function isolateTmpdir(): void {
	const saved = process.env.TMPDIR;
	let dir = "";
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "livespec-test-tmp-"));
		process.env.TMPDIR = dir;
	});
	afterEach(async () => {
		if (saved === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = saved;
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
}
