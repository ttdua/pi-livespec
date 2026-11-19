// One short rubric per review subject; every reviewer packet carries the rubric of its subject.

import type { ReviewSubject } from "./roles.ts";

const RUBRICS: Record<string, string> = {
	spec: "Review the specs diff: each requirement is testable, scenarios cover it, nothing contradicts the living specs or the constraints.",
	plan: "Review the units: each covers named requirements, `Files` do not overlap without `Depends`, `Verify` proves the `Done means` items.",
	unit: "Review the unit's diff against its `Done means`, `Scenarios` and `Files`: defects, missed context, lowered standards, edits outside `Files`.",
	change: "Review the whole change against the specs, the constraints and the decisions: integration defects, gaps between units, missed context.",
};

export function rubricFor(subject: ReviewSubject): string {
	if (subject.startsWith("persona:")) return `Review the change as the persona "${subject.slice("persona:".length)}": report what this lens finds, with evidence.`;
	return RUBRICS[subject] ?? RUBRICS.change ?? "";
}
