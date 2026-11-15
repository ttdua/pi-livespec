// The body an amendment produces (design D9a), pure: edit replaces the unit's
// block, add appends a block, drop removes it. Every other line is kept.

import { parseChange } from "../core/change.ts";
import { insertUnitBlock, removeUnitBlock, replaceUnitBlock } from "../core/unit-blocks.ts";
import type { AmendSnapshot } from "./approver.ts";

/** The block's current lines, heading to status line, without line endings. */
function blockLines(body: string, unit: string): string[] | undefined {
	const change = parseChange(body);
	const u = change.units.find((x) => x.id === unit);
	return u ? change.lines.slice(u.startLine, u.endLine + 1).map((l) => l.text) : undefined;
}

/** The amended body; returns `body` itself when the amendment is already applied. */
export function amendedBody(body: string, s: AmendSnapshot): string {
	const current = blockLines(body, s.unit);
	if (s.action === "drop") return current === undefined ? body : removeUnitBlock(body, s.unit);
	const lines = s.lines ?? [];
	if (s.action === "add") return current === undefined ? insertUnitBlock(body, lines) : body;
	if (current === undefined) throw new Error(`unit ${s.unit} is not in the body`);
	return current.join("\n") === lines.join("\n") ? body : replaceUnitBlock(body, s.unit, lines);
}
