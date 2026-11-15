// `skill_note`: records why an optional skill of the active phase was used, as
// an own `skill-note` marked comment with id `<phase>.<skill>`.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SKILL_NOTE_KIND } from "../engine/comments-cache.ts";
import type { NextStep } from "../engine/state-types.ts";
import { writeMarked } from "../forge/markers.ts";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult } from "./guard.ts";

export type SkillNoteParams = { skill: string; reason: string };

const MAX_REASON = 200;
const REASON_RULE = `The reason must be one line of 1 to ${MAX_REASON} characters.`;

function validateReason(reason: string): string | undefined {
	const trimmed = reason.trim();
	if (trimmed === "" || trimmed.length > MAX_REASON || /[\r\n]/.test(trimmed)) return REASON_RULE;
	return undefined;
}

function validateSkill(step: NextStep, skill: string): string | undefined {
	if (step.phase === undefined) return "The change has no active phase, so no skill note can be recorded.";
	if (step.optional.includes(skill)) return undefined;
	const optional = step.optional.length === 0 ? "none" : step.optional.join(", ");
	return `${skill} is not an optional skill of ${step.phase}; optional skills: ${optional}.`;
}

export async function runSkillNote(p: SkillNoteParams): Promise<ToolResult<undefined>> {
	const reasonError = validateReason(p.reason);
	if (reasonError) return toolResult(reasonError, undefined, true);
	const w = await prepareWrite();
	if (!w.ok) return toolResult(w.message, undefined, true);
	const change = requireChange(w.session);
	if (!change.ok) return toolResult(change.message, undefined, true);
	const skillError = validateSkill(change.step, p.skill);
	if (skillError) return toolResult(skillError, undefined, true);
	const phase = change.step.phase as string;
	const n = change.state.issue.number;
	const id = `${phase}.${p.skill}`;
	await w.forge.createComment(n, writeMarked(SKILL_NOTE_KIND, id, { phase, skill: p.skill, reason: p.reason.trim() }));
	await afterForgeWrite(w.session, n);
	return toolResult(`Recorded skill note ${id} on #${n}.`, undefined);
}

export function registerSkillNote(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "skill_note",
		label: "Record skill note",
		description:
			"Record a one-line reason (1 to 200 characters) for using an optional skill of the active livespec phase. Required skills and skills of other phases are refused.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: {
			type: "object",
			properties: {
				skill: { type: "string", description: "Name of an optional skill of the active phase" },
				reason: { type: "string", description: "One line, 1 to 200 characters" },
			},
			required: ["skill", "reason"],
		} as never,
		execute: (_id, params) => runSkillNote(params as SkillNoteParams),
	});
}
