import { type Line, joinLines, splitLines } from "./lines.ts";

export type GlossaryEntry = { term: string; definition: string; line: number };
export type Glossary = { entries: GlossaryEntry[]; lines: Line[] };

const ENTRY = /^- \*\*(.+?)\*\*:\s*(.*)$/;

export function parseGlossary(text: string): Glossary {
	const lines = splitLines(text);
	const entries: GlossaryEntry[] = [];
	lines.forEach((l, i) => {
		const m = ENTRY.exec(l.text);
		if (m) entries.push({ term: m[1] ?? "", definition: (m[2] ?? "").trim(), line: i + 1 });
	});
	return { entries, lines };
}

export function serializeGlossary(g: Glossary): string {
	return joinLines(g.lines);
}
