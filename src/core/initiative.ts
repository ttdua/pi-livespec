import { type Line, joinLines, splitLines } from "./lines.ts";

export type InitiativeChange = {
	checked: boolean;
	number: number;
	name: string;
	depends: number[];
	line: number;
};

export type Initiative = {
	goal: string;
	capabilities: string[];
	changes: InitiativeChange[];
	lines: Line[];
};

export const CHANGE_ENTRY = /^- \[( |x)\] #(\d+) (\S+) — Depends: (.*?)\s*$/;

function parseDepends(value: string): number[] {
	return [...value.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

export function parseInitiative(text: string): Initiative {
	const lines = splitLines(text);
	let goal = "";
	let capabilities: string[] = [];
	const changes: InitiativeChange[] = [];
	let inChanges = false;
	lines.forEach((l, i) => {
		if (/^## /.test(l.text)) {
			inChanges = l.text.slice(3).trim() === "Changes";
			return;
		}
		if (inChanges) {
			const m = CHANGE_ENTRY.exec(l.text);
			if (m) {
				changes.push({
					checked: m[1] === "x",
					number: Number(m[2]),
					name: m[3] as string,
					depends: parseDepends(m[4] as string),
					line: i,
				});
			}
			return;
		}
		const g = /^Goal:[ \t]*(.*?)\s*$/.exec(l.text);
		if (g) goal = g[1] as string;
		const c = /^Capabilities:[ \t]*\[(.*)\]\s*$/.exec(l.text);
		if (c) {
			capabilities = (c[1] as string)
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s !== "");
		}
	});
	return { goal, capabilities, changes, lines };
}

export function serializeInitiative(i: Initiative): string {
	return joinLines(i.lines);
}

export type ChangeEntry = { number: number; name: string; depends: number[] };

const entryText = (e: ChangeEntry): string =>
	`- [ ] #${e.number} ${e.name} — Depends: ${e.depends.length === 0 ? "—" : e.depends.map((d) => `#${d}`).join(", ")}`;

function edit(body: string, f: (i: Initiative) => Line[]): string {
	return joinLines(f(parseInitiative(body)));
}

function insertAt(lines: Line[], at: number, text: string): Line[] {
	const prev = lines[at - 1];
	const eol = prev?.eol || lines.find((l) => l.eol !== "")?.eol || "\n";
	const out = [...lines];
	if (prev && prev.eol === "") out[at - 1] = { text: prev.text, eol };
	out.splice(at, 0, { text, eol: prev && at === lines.length && prev.eol === "" ? "" : eol });
	return out;
}

/** Adds an entry after the last one, or under `## Changes` when there is none. */
export function appendChange(body: string, e: ChangeEntry): string {
	return edit(body, (i) => {
		const last = i.changes[i.changes.length - 1];
		if (last) return insertAt(i.lines, last.line + 1, entryText(e));
		const h = i.lines.findIndex((l) => /^## Changes\s*$/.test(l.text));
		if (h === -1) return [...insertAt(i.lines, i.lines.length, "## Changes"), ...insertAt([], 0, entryText(e))];
		return insertAt(i.lines, h + 1, entryText(e));
	});
}

export function insertChangeAfter(body: string, after: number, e: ChangeEntry): string {
	const i = parseInitiative(body);
	const target = i.changes.find((c) => c.number === after);
	if (!target) return appendChange(body, e);
	return joinLines(insertAt(i.lines, target.line + 1, entryText(e)));
}

/** Adds an entry right before entry `before`, or after the last one when `before` is not listed. */
export function insertChangeBefore(body: string, before: number, e: ChangeEntry): string {
	const i = parseInitiative(body);
	const target = i.changes.find((c) => c.number === before);
	if (!target) return appendChange(body, e);
	return joinLines(insertAt(i.lines, target.line, entryText(e)));
}

export function setChangeDepends(body: string, n: number, depends: number[]): string {
	return edit(body, (i) => {
		const c = i.changes.find((x) => x.number === n);
		if (!c) return i.lines;
		const out = [...i.lines];
		const old = out[c.line] as Line;
		out[c.line] = { text: entryText({ number: n, name: c.name, depends }).replace(/^- \[ \]/, `- [${c.checked ? "x" : " "}]`), eol: old.eol };
		return out;
	});
}

export function removeChange(body: string, n: number): string {
	return edit(body, (i) => {
		const c = i.changes.find((x) => x.number === n);
		return c ? i.lines.filter((_, idx) => idx !== c.line) : i.lines;
	});
}

export function initiativeBody(goal: string, capabilities: string[]): string {
	return `Goal: ${goal}\nCapabilities: [${capabilities.join(", ")}]\n\n## Changes\n`;
}
