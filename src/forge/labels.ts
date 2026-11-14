// Label names and creation. The Forge contract has no label-creation method,
// so `ensureLabels` works against the minimal LabelRepo interface below.

export const LABEL_LIVESPEC = "livespec";
export const LABEL_INITIATIVE = "livespec:initiative";
export const LABEL_PARKED = "livespec:parked";

export function phaseLabel(phase: string): string {
	return `livespec:phase/${phase}`;
}

/** Repository-level label operations needed to create missing labels. */
export interface LabelRepo {
	listLabels(): Promise<string[]>;
	createLabel(name: string): Promise<void>;
}

/** Creates each of `labels` that the repository does not have yet. Existing labels are not touched. */
export async function ensureLabels(repo: LabelRepo, labels: string[]): Promise<void> {
	const existing = new Set(await repo.listLabels());
	const missing = new Set(labels.filter((label) => !existing.has(label)));
	for (const label of missing) {
		await repo.createLabel(label);
	}
}
