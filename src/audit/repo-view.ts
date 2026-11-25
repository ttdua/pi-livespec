// A read-only view of the files of one commit; detectors read only through it.

import type { Git } from "../engine/git.ts";

export type RepoView = { commit: string; files: string[]; read(path: string): Promise<string | undefined> };

/** The tree of `commit`, read through `git ls-tree` and `git show`; each file is read at most once. */
export async function repoViewAt(git: Pick<Git, "listTree" | "showFile">, commit: string): Promise<RepoView> {
	const files = await git.listTree(commit);
	const cache = new Map<string, Promise<string | undefined>>();
	return {
		commit,
		files,
		read(path) {
			let content = cache.get(path);
			if (content === undefined) {
				content = git.showFile(commit, path);
				cache.set(path, content);
			}
			return content;
		},
	};
}

/** An in-memory view, for tests and callers that already hold the files. */
export function memoryView(files: Record<string, string>, commit = "memory"): RepoView {
	return { commit, files: Object.keys(files), read: async (path) => files[path] };
}
