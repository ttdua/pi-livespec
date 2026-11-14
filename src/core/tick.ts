import { parseChange } from "./change.ts";
import { CHANGE_ENTRY, parseInitiative } from "./initiative.ts";
import { type Line, joinLines } from "./lines.ts";

export class TickError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TickError";
	}
}

function replaceLine(lines: Line[], index: number, text: string): string {
	const out = lines.slice();
	out[index] = { text, eol: (lines[index] as Line).eol };
	return joinLines(out);
}

function flipUnit(body: string, id: string, from: "pending" | "done"): string {
	const change = parseChange(body);
	const unit = change.units.find((u) => u.id === id);
	if (!unit) throw new TickError(`unit ${id} not found`);
	if (unit.statusLine === -1) throw new TickError(`unit ${id} has no status line`);
	if (unit.done !== (from === "done")) throw new TickError(`unit ${id} is already ${from === "done" ? "pending" : "done"}`);
	return replaceLine(change.lines, unit.statusLine, from === "pending" ? "- [x] done" : "- [ ] pending");
}

function flipChange(body: string, n: number, checked: boolean): string {
	const init = parseInitiative(body);
	const entry = init.changes.find((c) => c.number === n);
	if (!entry) throw new TickError(`change #${n} not found`);
	if (entry.checked === checked) throw new TickError(`change #${n} is already ${checked ? "checked" : "unchecked"}`);
	const text = (init.lines[entry.line] as Line).text;
	if (!CHANGE_ENTRY.test(text)) throw new TickError(`change #${n} line is malformed`);
	return replaceLine(init.lines, entry.line, text.replace(/^- \[[ x]\]/, checked ? "- [x]" : "- [ ]"));
}

export function tickUnit(body: string, id: string): string {
	return flipUnit(body, id, "pending");
}
export function untickUnit(body: string, id: string): string {
	return flipUnit(body, id, "done");
}
export function tickChange(body: string, n: number): string {
	return flipChange(body, n, true);
}
export function untickChange(body: string, n: number): string {
	return flipChange(body, n, false);
}
