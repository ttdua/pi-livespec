// Filesystem layout of the shared agent-skills clone under the user's home.

import { randomBytes } from "node:crypto";
import { join } from "node:path";

export type ContentPaths = {
	root: string;
	mirror: string;
	current: string;
	lock: string;
	tree(sha: string): string;
	/** A fresh, unique staging directory for `sha` on every call. */
	staging(sha: string): string;
};

const STAGING_RANDOM_BYTES = 4;

export function contentPaths(home: string): ContentPaths {
	const root = join(home, ".pi", "agent", "livespec", "agent-skills");
	return {
		root,
		mirror: join(root, "mirror.git"),
		current: join(root, "current"),
		lock: join(root, "livespec.lock"),
		tree: (sha) => join(root, sha),
		staging: (sha) => join(root, `.staging-${sha}-${randomBytes(STAGING_RANDOM_BYTES).toString("hex")}`),
	};
}
