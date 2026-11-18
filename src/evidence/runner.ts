// Runs a `Verify` command: guard first, then `/bin/sh -c` in its own process group
// with stdin closed, a timeout and abort, and redacted output kept as a bounded tail.

import { spawn } from "node:child_process";
import { outputTail, StreamRedactor } from "./output.ts";

export interface VerifyRun {
	exit: number | null;
	timedOut: boolean;
	aborted: boolean;
	spawnError?: string;
	output: string;
	totalBytes: number;
}

export interface RunOptions {
	cwd: string;
	timeoutS: number;
	guard: (cmd: string) => string | undefined;
	tokens: string[];
	tailBytes: number;
	signal?: AbortSignal;
}

/** Time between SIGTERM and SIGKILL to the process group. */
export const KILL_GRACE_MS = 5000;
const MS_PER_S = 1000;

/** The last `limit` bytes of a stream, with the count of every byte seen. */
class TailBuffer {
	private buf: Buffer = Buffer.alloc(0);
	total = 0;

	constructor(private readonly limit: number) {}

	append(bytes: Buffer): void {
		if (bytes.length === 0) return;
		this.total += bytes.length;
		const joined = Buffer.concat([this.buf, bytes]);
		this.buf = joined.length > this.limit ? Buffer.from(joined.subarray(joined.length - this.limit)) : joined;
	}

	text(): string {
		return outputTail(this.buf, this.total, this.limit);
	}
}

/** Signals a whole process group; the group may already be gone. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// ESRCH: every process in the group has exited.
	}
}

const notSpawned = (o: Partial<VerifyRun>): VerifyRun => ({ exit: null, timedOut: false, aborted: false, output: "", totalBytes: 0, ...o });

/** Runs `command` unless `guard` blocks it. Never rejects: a failure to start is `spawnError`. */
export async function runVerify(command: string, o: RunOptions): Promise<VerifyRun | { blocked: string }> {
	const blocked = o.guard(command);
	if (blocked !== undefined) return { blocked };
	if (o.signal?.aborted) return notSpawned({ aborted: true });
	return spawnRun(command, o);
}

function spawnRun(command: string, o: RunOptions): Promise<VerifyRun> {
	return new Promise((resolve) => {
		const redactor = new StreamRedactor(o.tokens);
		const tail = new TailBuffer(o.tailBytes);
		const state = { timedOut: false, aborted: false, spawnError: undefined as string | undefined };
		const child = spawn("/bin/sh", ["-c", command], { cwd: o.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let killTimer: NodeJS.Timeout | undefined;
		const stop = (reason: "timedOut" | "aborted"): void => {
			if (child.pid === undefined || state.timedOut || state.aborted) return;
			state[reason] = true;
			killGroup(child.pid, "SIGTERM");
			killTimer = setTimeout(() => {
				if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
				// A process that left the group may still hold the pipes; stop waiting for them.
				child.stdout.destroy();
				child.stderr.destroy();
			}, KILL_GRACE_MS);
		};
		const timeout = setTimeout(() => stop("timedOut"), o.timeoutS * MS_PER_S);
		const onAbort = (): void => stop("aborted");
		o.signal?.addEventListener("abort", onAbort, { once: true });

		const collect = (chunk: Buffer): void => tail.append(redactor.push(chunk));
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", (error) => {
			state.spawnError = error.message;
		});
		// `close` follows both `exit` and `error`, after the pipes are drained.
		child.on("close", (code) => {
			clearTimeout(timeout);
			clearTimeout(killTimer);
			o.signal?.removeEventListener("abort", onAbort);
			// Members of the group may outlive the shell and hold no pipe; do not leave them behind.
			if (child.pid !== undefined && (state.timedOut || state.aborted)) killGroup(child.pid, "SIGKILL");
			tail.append(redactor.end());
			resolve({
				exit: state.spawnError !== undefined ? null : code,
				timedOut: state.timedOut,
				aborted: state.aborted,
				...(state.spawnError !== undefined ? { spawnError: state.spawnError } : {}),
				output: tail.text(),
				totalBytes: tail.total,
			});
		});
	});
}
