// The `## Durable docs` table: rows to text, the versioned body edit, and the refusals of `docs_table`. Pure.

import { replaceSection } from "../core/sections.ts";
import { type DurableFacts, hardCovered } from "./durable-docs.ts";

export type DocsRow = { file: string; status: "updated" | "not needed"; reason?: string };

const HEADER = ["| File | Status |", "| --- | --- |"];

const statusCell = (row: DocsRow): string => (row.status === "updated" ? "updated" : `not needed — ${(row.reason ?? "").trim()}`);

export function docsTableText(rows: DocsRow[]): string {
	return [...HEADER, ...rows.map((r) => `| ${r.file.trim()} | ${statusCell(r)} |`)].join("\n");
}

/** The body with the `## Durable docs` rows replaced; every other section stays byte for byte. */
export function applyDocsTable(body: string, rows: DocsRow[]): string {
	return replaceSection(body, "Durable docs", docsTableText(rows));
}

const BAD_CELL = /[|\r\n]/;

function rowRefusal(row: DocsRow, facts: DurableFacts, covered: Map<string, string>): string | undefined {
	if (row.file.trim() === "") return "a row has an empty file.";
	if (BAD_CELL.test(row.file) || BAD_CELL.test(row.reason ?? "")) return `${row.file}: a file or reason must not hold \`|\` or a line break.`;
	if (row.status === "updated") return facts.files.includes(row.file) ? undefined : `${row.file} is marked updated but the change diff does not touch it.`;
	if ((row.reason ?? "").trim() === "") return `${row.file}: a \`not needed\` row needs a reason.`;
	const why = covered.get(row.file);
	return why === undefined ? undefined : `${row.file} cannot be \`not needed\`: ${why}.`;
}

/** Why `rows` cannot be written, or undefined. */
export function docsRowsRefusal(rows: DocsRow[], facts: DurableFacts): string | undefined {
	const covered = hardCovered(facts);
	for (const row of rows) {
		const why = rowRefusal(row, facts, covered);
		if (why !== undefined) return why;
	}
	return undefined;
}
