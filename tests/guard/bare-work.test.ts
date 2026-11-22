import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { appendBareWork, isBareWork, localDate } from "../../src/guard/bare-work.ts";
import { makeRepo, writeIn } from "../helpers/repo.ts";

const yes = async () => true;
const no = async () => false;
const LINE = "2026-11-22 — src/app.ts — edit outside a change or fix branch\n";
const file = (root: string) => readFile(join(root, "specs/bare-work.md"), "utf8");

describe("isBareWork", () => {
	const at = (branch: string, path: string, tracked = yes) => isBareWork({ root: "/proj", path, branch, tracked });

	test("a tracked file on main is bare work", async () => {
		expect(await at("main", "/proj/src/app.ts")).toBe("src/app.ts");
		expect(await at("main", "src/app.ts")).toBe("src/app.ts");
	});
	test("a rejecting tracked check rejects", async () => {
		await expect(at("main", "src/app.ts", async () => Promise.reject(new Error("git down")))).rejects.toThrow("git down");
	});
	test("fix and change branches are not bare", async () => {
		expect(await at("fix/typo", "src/app.ts")).toBeUndefined();
		expect(await at("livespec/rate-limit", "src/app.ts")).toBeUndefined();
	});
	test("specs files and untracked files are not bare", async () => {
		expect(await at("main", "specs/product.md")).toBeUndefined();
		expect(await at("main", "src/new.ts", no)).toBeUndefined();
	});
	test("path outside the project is not logged", async () => {
		expect(await at("main", "/elsewhere/a.ts")).toBeUndefined();
		expect(await at("main", "../a.ts")).toBeUndefined();
	});
});

describe("appendBareWork", () => {
	test("creates the file with the exact line", async () => {
		const root = await makeRepo();
		expect(await appendBareWork(root, "src/app.ts", "edit", "2026-11-22")).toEqual({ written: true });
		expect(await file(root)).toBe(LINE);
	});
	test("Logged once per day; a new date appends", async () => {
		const root = await makeRepo();
		await appendBareWork(root, "src/app.ts", "edit", "2026-11-22");
		expect((await appendBareWork(root, "src/app.ts", "write", "2026-11-22")).written).toBe(false);
		expect(await file(root)).toBe(LINE);
		await appendBareWork(root, "src/app.ts", "edit", "2026-11-23");
		expect(await file(root)).toBe(`${LINE}2026-11-23 — src/app.ts — edit outside a change or fix branch\n`);
	});
	test("adds a newline before appending to a file that lacks one", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/bare-work.md", "# Bare work");
		await appendBareWork(root, "src/app.ts", "edit", "2026-11-22");
		expect(await file(root)).toBe(`# Bare work\n${LINE}`);
	});
	test("parallel edits log once", async () => {
		const root = await makeRepo();
		await Promise.all([appendBareWork(root, "src/app.ts", "edit", "2026-11-22"), appendBareWork(root, "src/app.ts", "edit", "2026-11-22")]);
		expect(await file(root)).toBe(LINE);
	});
	test("a read-only specs directory returns the error without throwing", async () => {
		const root = await makeRepo();
		await mkdir(join(root, "specs"));
		await chmod(join(root, "specs"), 0o500);
		const out = await appendBareWork(root, "src/app.ts", "edit", "2026-11-22");
		await chmod(join(root, "specs"), 0o700);
		expect(out.written).toBe(false);
		expect(out.error).toBeTruthy();
	});
});

test("localDate uses the local calendar date", () => {
	expect(localDate(new Date(2026, 10, 2, 23, 30))).toBe("2026-11-02");
});
