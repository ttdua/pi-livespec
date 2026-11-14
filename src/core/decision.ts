import { parseFrontmatter } from "./frontmatter.ts";
import { type Line, joinLines, splitLines } from "./lines.ts";

export type Decision = {
	number: number;
	slug: string;
	status: "accepted" | "superseded";
	supersededBy?: number;
	spine: boolean;
	capabilities: string[];
	lines: Line[];
};

const FILE_NAME = /(\d+)-(.+)\.md$/;

function toNumber(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isInteger(v)) return v;
	if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
	return undefined;
}

/** Number and slug come from the file name `NNNN-<slug>.md`; the rest from front matter. */
export function parseDecision(file: string, text: string): Decision {
	const { data } = parseFrontmatter(text);
	const name = file.split("/").pop() ?? file;
	const m = FILE_NAME.exec(name);
	const supersededBy = toNumber(data.superseded_by);
	const caps = Array.isArray(data.capabilities)
		? data.capabilities.filter((c): c is string => typeof c === "string")
		: [];
	return {
		number: m ? Number(m[1]) : Number.NaN,
		slug: m?.[2] ?? "",
		status: data.status === "superseded" ? "superseded" : "accepted",
		...(supersededBy === undefined ? {} : { supersededBy }),
		spine: data.spine === true,
		capabilities: caps,
		lines: splitLines(text),
	};
}

export function serializeDecision(d: Decision): string {
	return joinLines(d.lines);
}
