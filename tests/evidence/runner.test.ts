import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type RunOptions, runVerify, type VerifyRun } from "../../src/evidence/runner.ts";

const MAX = 8192;
let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "ls-run-"));
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

const opts = (o: Partial<RunOptions> = {}): RunOptions => ({
	cwd,
	timeoutS: 30,
	guard: () => undefined,
	tokens: [],
	tailBytes: MAX,
	...o,
});

/** Runs a command that the test expects to be spawned. */
async function ran(command: string, o: Partial<RunOptions> = {}): Promise<VerifyRun> {
	const result = await runVerify(command, opts(o));
	if ("blocked" in result) throw new Error(`unexpected block: ${result.blocked}`);
	return result;
}

/** Whether any process command line matches `pattern`. */
function running(pattern: string): boolean {
	try {
		execFileSync("pgrep", ["-f", pattern]);
		return true;
	} catch (error) {
		// pgrep exits 1 when nothing matches; any other failure must not read as "not running".
		if ((error as { status?: number }).status === 1) return false;
		throw error;
	}
}

describe("runVerify", () => {
	test("Command not found is not red", async () => {
		const r = await ran("nosuchtool-xyz");
		expect(r.exit).toBe(127);
		expect(r.timedOut).toBe(false);
	});

	test("exit code and combined output are captured", async () => {
		const r = await ran("echo out; echo err >&2; exit 3");
		expect(r.exit).toBe(3);
		expect(r.output).toContain("out");
		expect(r.output).toContain("err");
		expect(r.totalBytes).toBe(8);
	});

	test("Timeout", async () => {
		const started = Date.now();
		const r = await ran("sleep 5; echo done", { timeoutS: 1 });
		expect(r.timedOut).toBe(true);
		expect(r.output).not.toContain("done");
		expect(Date.now() - started).toBeLessThan(7000);
		expect(running("sleep 5")).toBe(false);
	}, 10_000);

	test("Blocked Verify is never run", async () => {
		const marker = join(cwd, "marker");
		const r = await runVerify(`touch ${marker}`, opts({ guard: () => "git push is blocked" }));
		expect(r).toEqual({ blocked: "git push is blocked" });
		expect(existsSync(marker)).toBe(false);
	});

	test("the guard sees the exact command", async () => {
		const seen: string[] = [];
		await ran("true", { guard: (c) => (seen.push(c), undefined) });
		expect(seen).toEqual(["true"]);
	});

	test("a token in tokens is redacted", async () => {
		const r = await ran("printf 'before s3cr3t-tok'; printf 'en after'", { tokens: ["s3cr3t-token"] });
		expect(r.output).not.toContain("s3cr3t");
		expect(r.output).toBe("before *** after");
	});

	test("cat returns immediately because stdin is closed", async () => {
		const r = await ran("cat", { timeoutS: 5 });
		expect(r.exit).toBe(0);
		expect(r.timedOut).toBe(false);
	});

	test("runner output over the budget carries the truncation mark", async () => {
		const r = await ran("head -c 20000 /dev/urandom | base64");
		expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(MAX);
		expect(r.output.startsWith("…[truncated ")).toBe(true);
		expect(r.totalBytes).toBeGreaterThan(MAX);
	});

	test("abort kills the run and removes the worktree", async () => {
		const controller = new AbortController();
		const pending = ran("sleep 30", { signal: controller.signal });
		setTimeout(() => controller.abort(), 300);
		const r = await pending;
		expect(r.aborted).toBe(true);
		expect(running("sleep 30")).toBe(false);
	}, 10_000);

	test("an already aborted signal does not spawn", async () => {
		const marker = join(cwd, "marker");
		const r = await ran(`touch ${marker}`, { signal: AbortSignal.abort() });
		expect(r.aborted).toBe(true);
		expect(r.exit).toBeNull();
		expect(existsSync(marker)).toBe(false);
	});

	test("a missing cwd is a spawn error", async () => {
		const r = await ran("true", { cwd: join(cwd, "missing") });
		expect(r.spawnError).toBeDefined();
		expect(r.exit).toBeNull();
	});
});
