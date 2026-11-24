// drift-audit "Audit suggestions": the local `audit.json` under the git common dir.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type AuditState, readAuditState, writeAuditState } from "../../src/audit/state.ts";
import { makeRepo } from "../helpers/repo.ts";

const failRename = vi.hoisted(() => ({ on: false }));

vi.mock("node:fs/promises", async (original) => {
	const real = await original<typeof import("node:fs/promises")>();
	return {
		...real,
		rename: async (from: string, to: string) => {
			if (failRename.on) throw new Error("rename failed");
			return real.rename(from, to);
		},
	};
});

afterEach(() => {
	failRename.on = false;
});

/** A git seam whose common dir is a fresh temp directory's `.git`. */
async function store(): Promise<{ dir: string; git: { commonDir(): Promise<string> } }> {
	const root = await makeRepo();
	const dir = join(root, ".git");
	return { dir, git: { commonDir: async () => dir } };
}

const STATE: AuditState = {
	cursor: "a".repeat(40),
	fixCursor: "b".repeat(40),
	auditedCommit: "c".repeat(40),
	pending: [
		{ kind: "initiative", initiative: 30 },
		{ kind: "commit", sha: "d".repeat(40), capabilities: ["rate-limit"] },
	],
};

describe("audit state", () => {
	test("missing file is no state", async () => {
		const { git } = await store();
		expect(await readAuditState(git)).toEqual({ pending: [] });
	});

	test("round trip, creating the livespec directory", async () => {
		const { dir, git } = await store();
		await writeAuditState(git, STATE);
		expect(JSON.parse(await readFile(join(dir, "livespec", "audit.json"), "utf8"))).toEqual(STATE);
		expect(await readAuditState(git)).toEqual(STATE);
	});

	test("corrupt state treated as missing", async () => {
		const { dir, git } = await store();
		await mkdir(join(dir, "livespec"), { recursive: true });
		const file = join(dir, "livespec", "audit.json");
		for (const text of ['{"cursor": "aaa", "pend', "null", "[]", '{"pending": 3}', '{"pending": [{"kind": "commit", "sha": 1}]}', '{"cursor": 5, "pending": []}']) {
			await writeFile(file, text);
			expect(await readAuditState(git), text).toEqual({ pending: [] });
		}
	});

	test("write is atomic: a failed rename leaves the previous state and no stray file", async () => {
		const { dir, git } = await store();
		await writeAuditState(git, { pending: [] });
		failRename.on = true;
		await expect(writeAuditState(git, STATE)).rejects.toThrow("rename failed");
		expect(await readAuditState(git)).toEqual({ pending: [] });
		expect(await readdir(join(dir, "livespec"))).toEqual(["audit.json"]);
	});
});
