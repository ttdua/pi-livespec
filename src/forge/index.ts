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
export { GitHubForge } from "./github.ts";
export { GiteaForge } from "./gitea.ts";
export { CachedForge } from "./cache.ts";
export { detectForge } from "./detect.ts";
export {
	readMarkedComments,
	registerKind,
	writeMarked,
	type MarkedComment,
	type MarkedReadResult,
} from "./markers.ts";
export { LABEL_INITIATIVE, LABEL_LIVESPEC, LABEL_PARKED, phaseLabel } from "./labels.ts";
