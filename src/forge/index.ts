// Public surface of the forge layer. Re-exports only; no logic lives here.

export type {
	Check,
	CheckState,
	CheckSummary,
	Comment,
	Forge,
	ForgeKind,
	Issue,
	IssueQuery,
	IssueState,
	PullRequest,
	PullRequestState,
	Review,
	ReviewComment,
	ReviewState,
	Version,
	WriteResult,
} from "./types.ts";
export { ForgeError, type ForgeErrorCode } from "./errors.ts";
export { GitHubForge, type ExecFn, type ExecResult, type GitHubForgeOptions } from "./github.ts";
export { GiteaForge, type GiteaOptions } from "./gitea.ts";
export { CachedForge, type CachedForgeOptions } from "./cache.ts";
export { detectForge, type DetectDeps } from "./detect.ts";
export {
	readMarkedComments,
	registerKind,
	writeMarked,
	type MarkedComment,
	type MarkedReadResult,
} from "./markers.ts";
export { LABEL_INITIATIVE, LABEL_LIVESPEC, LABEL_PARKED, phaseLabel } from "./labels.ts";
