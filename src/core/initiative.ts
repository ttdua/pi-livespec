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
