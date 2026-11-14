import { describe, expect, it } from "vitest";
import {
	LABEL_INITIATIVE,
	LABEL_LIVESPEC,
	LABEL_PARKED,
	type LabelRepo,
	ensureLabels,
	phaseLabel,
} from "../../src/forge/labels.ts";

function stubRepo(existing: string[]): LabelRepo & { created: string[] } {
	const created: string[] = [];
	return {
		created,
		listLabels: async () => [...existing],
		createLabel: async (name: string) => {
			created.push(name);
		},
	};
}

describe("label constants", () => {
	it("uses the documented names", () => {
		expect(LABEL_LIVESPEC).toBe("livespec");
		expect(LABEL_INITIATIVE).toBe("livespec:initiative");
		expect(LABEL_PARKED).toBe("livespec:parked");
		expect(phaseLabel("apply")).toBe("livespec:phase/apply");
	});
});

describe("ensureLabels", () => {
	it("creates only the labels the repository is missing", async () => {
		const repo = stubRepo([LABEL_LIVESPEC]);
		await ensureLabels(repo, [LABEL_LIVESPEC, phaseLabel("apply")]);
		expect(repo.created).toEqual([phaseLabel("apply")]);
	});

	it("creates nothing when every label already exists", async () => {
		const repo = stubRepo([LABEL_LIVESPEC, LABEL_PARKED]);
		await ensureLabels(repo, [LABEL_LIVESPEC, LABEL_PARKED]);
		expect(repo.created).toEqual([]);
	});

	it("creates each missing label once even when it is requested twice", async () => {
		const repo = stubRepo([]);
		await ensureLabels(repo, [LABEL_INITIATIVE, LABEL_INITIATIVE]);
		expect(repo.created).toEqual([LABEL_INITIATIVE]);
	});
});
