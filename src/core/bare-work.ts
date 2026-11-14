import { type Line, joinLines, splitLines } from "./lines.ts";

export type BareWorkEntry = { date: string; files: string[]; summary: string; line: number };
export type BareWork = { entries: BareWorkEntry[]; lines: Line[] };

/**
 * An entry line is `<date> — <files> — <summary>`. The separator is exactly
 * ` — ` (space, em dash, space); files are comma-separated; the summary may
 * itself contain ` — `. Lines that do not match are kept but not parsed.
 */
const SEPARATOR = " — ";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseBareWork(text: string): BareWork {
	const lines = splitLines(text);
	const entries: BareWorkEntry[] = [];
	lines.forEach((l, i) => {
		const parts = l.text.split(SEPARATOR);
		const [date, files, ...rest] = parts;
		if (!date || !DATE.test(date.trim()) || files === undefined || rest.length === 0) return;
		entries.push({
			date: date.trim(),
			files: files
				.split(",")
				.map((f) => f.trim())
				.filter((f) => f !== ""),
			summary: rest.join(SEPARATOR).trim(),
			line: i + 1,
		});
	});
	return { entries, lines };
}

export function serializeBareWork(b: BareWork): string {
	return joinLines(b.lines);
}
