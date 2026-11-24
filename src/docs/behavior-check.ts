// The I/O side of the `behavior-change` check: the behavior items of `git diff <Base>..HEAD` against the living
// specs of the work tree, and the registered check over them. The facts and results are pure in `behavior-change.ts`.

import { diffFilesOf } from "../engine/git.ts";
import type { CheckFn, CheckGit } from "../engine/registry.ts";
import { livingSpecs } from "../ship/context.ts";
import { type BehaviorItem, behaviorFacts, behaviorResults } from "./behavior-change.ts";

/**
 * The behavior items of the change; none without a Base. The changed paths are those ship sees: NUL-delimited, and a
 * rename counts both its old and new path, so moving a file out of a capability's `paths` still asks.
 */
export async function changeBehaviorItems(root: string, git: Pick<CheckGit, "diffNameStatus">, base: string | undefined): Promise<BehaviorItem[]> {
	if (base === undefined) return [];
	return behaviorFacts(diffFilesOf(await git.diffNameStatus(base, "HEAD")), await livingSpecs(root));
}

/** The `behavior-change` check: never asks, only reads the records. */
export const behaviorChangeCheck: CheckFn = async ({ root, change, git, marked, phase }) =>
	behaviorResults(await changeBehaviorItems(root, git, change.header.base), marked, phase);
