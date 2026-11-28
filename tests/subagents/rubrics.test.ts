import { describe, expect, test } from "vitest";
import { rubricFor } from "../../src/subagents/rubrics.ts";
import type { ReviewSubject } from "../../src/subagents/roles.ts";

const CONTRACT = 'approver-adapters "Interaction contract"';

describe("rubricFor", () => {
	test("every rubric names the interaction contract", () => {
		const subjects: ReviewSubject[] = ["spec", "plan", "unit", "change", "persona:security-auditor"];
		for (const subject of subjects) {
			expect(rubricFor(subject), subject).toContain(CONTRACT);
		}
	});

	test("the contract sentence closes every rubric", () => {
		const sentence = 'A new or changed human request that breaks approver-adapters "Interaction contract" is a finding.';
		for (const subject of ["spec", "plan", "unit", "change", "persona:security-auditor"] as ReviewSubject[]) {
			expect(rubricFor(subject).endsWith(sentence), subject).toBe(true);
		}
	});
});
