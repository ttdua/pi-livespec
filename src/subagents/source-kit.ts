// Helpers shared by the source providers: hashing, memoized forge reads, section slicing and the provider shape.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change } from "../core/change.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { parseMarked } from "../forge/markers.ts";
import type { Comment, Forge, Issue } from "../forge/types.ts";
import type { PacketContext, PacketSource, Placed, Placement, Target } from "./source-types.ts";

export type Reads = {
	issue(n: number): Promise<Issue>;
	comments(n: number): Promise<Comment[]>;
	login(): Promise<string>;
};

/** What every provider sees: the build context, the target and memoized forge reads. */
export type Cx = { ctx: PacketContext; target: Target; reads: Reads };

export type Provider = { name: string; run(cx: Cx): Promise<Placed[]> };

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const memo = <K, V>(load: (key: K) => Promise<V>): ((key: K) => Promise<V>) => {
	const cache = new Map<K, Promise<V>>();
	return (key) => {
		const hit = cache.get(key);
		if (hit) return hit;
		const made = load(key);
		cache.set(key, made);
		return made;
	};
};

export function makeReads(forge: Forge): Reads {
	const login = memo(async (_: 0) => (await forge.whoami()).login);
	return { issue: memo((n: number) => forge.getIssue(n)), comments: memo((n: number) => forge.listComments(n)), login: () => login(0) };
}

export function placed(source: Omit<PacketSource, "required"> & { required?: boolean }, place: Placement = "inline"): Placed {
	return { source: { required: true, ...source }, place };
}

/** `#12`, `12` or a URL ending in the number. */
export function numberOf(ref: string | undefined): number | undefined {
	const m = ref === undefined ? null : /(\d+)\s*$/.exec(ref);
	return m ? Number(m[1]) : undefined;
}

export const prNumber = (change: Change): number | undefined => numberOf(change.header.pr);

/** The issue and, once it exists, the pull request: the threads freshness watches. */
export const threadNumbers = (state: ChangeState): number[] => {
	const pr = prNumber(state.change);
	return pr === undefined ? [state.issue.number] : [state.issue.number, pr];
};

export { declaredCapabilities } from "../core/change.ts";

/** Lines of the `## <name>` section without its heading; the header is `name === ""`. */
export function sectionText(change: Change, name: string): string {
	const text = change.lines.map((l) => l.text);
	const heading = (t: string): boolean => t.startsWith("## ");
	const start = name === "" ? 0 : text.findIndex((t) => t === `## ${name}`) + 1;
	if (name !== "" && start === 0) return "";
	const end = text.findIndex((t, i) => i >= start && heading(t));
	return text.slice(start, end === -1 ? undefined : end).join("\n").trim();
}

/** The file's text, or undefined when it does not exist. */
export async function readText(root: string, rel: string): Promise<string | undefined> {
	try {
		return await readFile(join(root, rel), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** A relative path inside the tree; anything else (absolute, `..`) is refused. */
export const safeRelative = (p: string): boolean => p !== "" && !p.startsWith("/") && !p.split("/").includes("..");

/**
 * Human comments on the change issue and its pull request, as `comment:<id>` with their versions. Only a comment that
 * both was written by the plugin account and carries a valid marker is own; a plain comment by that account is human.
 * Reads go through `reads`, so a build that shares one `Reads` sees one snapshot.
 */
export async function humanComments(ctx: PacketContext, reads: Reads = makeReads(ctx.forge)): Promise<{ id: string; version: string }[]> {
	const login = await reads.login();
	const lists = await Promise.all(threadNumbers(ctx.state).map((n) => reads.comments(n)));
	const own = (c: Comment): boolean => c.author === login && parseMarked(c.body) !== null;
	return lists.flat().filter((c) => !own(c)).map((c) => ({ id: `comment:${c.id}`, version: c.updatedAt }));
}
