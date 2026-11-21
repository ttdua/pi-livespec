// The fix pull request title and body (small-fix-lane "Fix pull request body", design D3): commit subjects,
// `## Test`, then the `lane` decision block. Pure. The test output is untrusted (repository code prints it), so
// its fence outgrows its longest backtick run and its decision-marker lines are indented: no forged record parses.

import { type DecisionRecord, formatDecisionBlock } from "../decide/records.ts";
import { neutralizeClosing } from "../ship/pr-body.ts";

export type FixTest = { command: string; exit: number; head: string; output: string };
export type FixBodyInput = { slug: string; subjects: string[]; test: FixTest; record: DecisionRecord };

const MIN_FENCE = 3;
const SHORT_SHA = 7;
const MARKER_PREFIX = "<!-- livespec:decision:";

/** A backtick fence one longer than the longest backtick run in `text`, at least three. */
function fenceFor(text: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	return "`".repeat(Math.max(MIN_FENCE, longest + 1));
}

/** The output with every line starting a decision marker indented by two spaces. */
function defuseMarkers(output: string): string {
	return output
		.split("\n")
		.map((line) => (line.startsWith(MARKER_PREFIX) ? `  ${line}` : line))
		.join("\n");
}

function testSection(t: FixTest): string {
	const output = defuseMarkers(t.output.endsWith("\n") || t.output === "" ? t.output : `${t.output}\n`);
	const fence = fenceFor(output);
	return ["## Test", "", `\`${t.command}\` → exit ${t.exit} at ${t.head.slice(0, SHORT_SHA)}`, "", `${fence}text`, `${output}${fence}`].join("\n");
}

export function fixPullRequestBody(i: FixBodyInput): { title: string; body: string } {
	const commits = i.subjects.map((s) => `- ${s}`).join("\n");
	const text = neutralizeClosing(`${commits}\n\n${testSection(i.test)}`);
	return { title: i.subjects[0] ?? `fix/${i.slug}`, body: `${text}\n\n${formatDecisionBlock("lane", i.record)}\n` };
}
