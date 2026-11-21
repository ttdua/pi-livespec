// constraints-not-weakened: flags diff lines that weaken test or lint standards (design D11).

import { isTestFile } from "../evidence/pending.ts";
import type { Finding } from "../subagents/roles.ts";
import { type DiffFile, parseDiffFiles } from "./diff-lines.ts";

const SKIP_OR_ONLY = /\b(it|test|describe)\.(skip|only)\b|\bx(it|describe|test)\s*\(/;
const SUPPRESSION = /@ts-ignore|eslint-disable|@ts-expect-error[\s:]*$/;
const ASSERTION = /\bexpect\s*\(|\bassert\w*\s*\(|\.should\b/;
const CONSTRAINTS = "specs/constraints.md";
const FIX = "Restore the standard, or record the justification in specs/constraints.md before weakening it.";

type Options = { constraintsCited: boolean };

export function checkStandards(diff: string, opts: Options): Finding[] {
	return parseDiffFiles(diff).flatMap((file) => fileFindings(file, opts));
}

function fileFindings(file: DiffFile, opts: Options): Finding[] {
	const findings: Finding[] = [];
	if (file.deleted && isTestFile(file.path)) {
		findings.push(finding(`${file.path}:1`, `Deleted test file ${file.path}`, opts));
	}
	for (const line of file.lines) {
		if (line.kind === "add" && isWeakeningAdd(line.text)) {
			findings.push(finding(locate(file, line.newLine), `Added: ${line.text.trim()}`, opts));
		}
	}
	const assertionFinding = removedAssertionFinding(file, opts);
	if (assertionFinding) findings.push(assertionFinding);
	return findings;
}

function isWeakeningAdd(text: string): boolean {
	return SKIP_OR_ONLY.test(text) || SUPPRESSION.test(text);
}

// Flags a test file only when it removes more assertion lines than it adds, at its first removed assertion.
function removedAssertionFinding(file: DiffFile, opts: Options): Finding | undefined {
	if (!isTestFile(file.path)) return undefined;
	const removed = file.lines.filter((line) => line.kind === "remove" && ASSERTION.test(line.text));
	const added = file.lines.filter((line) => line.kind === "add" && ASSERTION.test(line.text));
	const first = removed[0];
	if (!first || removed.length <= added.length) return undefined;
	const evidence = `Removed ${removed.length} assertion lines, added ${added.length}`;
	return finding(`${file.path}:${first.oldLine}`, evidence, opts);
}

function locate(file: DiffFile, line: number): string {
	return `${file.path}:${line}`;
}

function finding(location: string, quote: string, opts: Options): Finding {
	const cite = opts.constraintsCited ? ` (see ${CONSTRAINTS})` : "";
	return {
		severity: "CRITICAL",
		kind: "lowered-standard",
		location,
		evidence: `${quote}${cite}`,
		fix: FIX,
		scope: "unit",
	};
}
