import { parse } from "yaml";
import { type Line, splitLines } from "./lines.ts";

export type Frontmatter = { data: Record<string, unknown>; body: Line[]; raw: Line[] };

const FENCE = "---";

/** Reads a leading `---` … `---` block. `raw` is empty when the block is absent or unterminated. */
export function parseFrontmatter(text: string): Frontmatter {
	const lines = splitLines(text);
	const absent: Frontmatter = { data: {}, body: lines, raw: [] };
	if (lines[0]?.text !== FENCE) return absent;
	const close = lines.findIndex((l, i) => i > 0 && l.text === FENCE);
	if (close === -1) return absent;
	const yamlText = lines
		.slice(1, close)
		.map((l) => l.text)
		.join("\n");
	const parsed: unknown = parse(yamlText);
	const data =
		parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	return { data, body: lines.slice(close + 1), raw: lines.slice(0, close + 1) };
}
