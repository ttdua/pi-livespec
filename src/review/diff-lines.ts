// Unified diff walker: yields each file's hunk lines with their old and new line numbers.
// parseGitDiff reads only headers, so line-level checks walk the hunks here.

export type DiffLine = { kind: "add" | "remove" | "context"; text: string; oldLine: number; newLine: number };
export type DiffFile = { path: string; deleted: boolean; lines: DiffLine[] };

type Cursor = { oldLine: number; newLine: number; oldLeft: number; newLeft: number };

const FILE_HEADER = /^diff --git a\/.+ b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiffFiles(diff: string): DiffFile[] {
	const files: DiffFile[] = [];
	let file: DiffFile | undefined;
	let cursor: Cursor | undefined;
	for (const raw of diff.split("\n")) {
		if (cursor && (cursor.oldLeft > 0 || cursor.newLeft > 0) && file) {
			cursor = consumeBodyLine(file, cursor, raw);
			continue;
		}
		const header = FILE_HEADER.exec(raw);
		if (header?.[1]) {
			file = { path: header[1], deleted: false, lines: [] };
			files.push(file);
			cursor = undefined;
			continue;
		}
		if (file && raw.startsWith("deleted file mode")) file.deleted = true;
		const hunk = HUNK_HEADER.exec(raw);
		if (hunk && file) cursor = startHunk(hunk);
	}
	return files;
}

function startHunk(match: RegExpExecArray): Cursor {
	const oldLine = Number(match[1]);
	const newLine = Number(match[3]);
	return {
		oldLine,
		newLine,
		oldLeft: match[2] === undefined ? 1 : Number(match[2]),
		newLeft: match[4] === undefined ? 1 : Number(match[4]),
	};
}

// Consumes one hunk body line and returns the advanced cursor. Counting the hunk's declared lines keeps
// body lines such as `--- x` or `+++ y` from being read as file headers.
function consumeBodyLine(file: DiffFile, cursor: Cursor, raw: string): Cursor {
	if (raw.startsWith("\\")) return cursor;
	const marker = raw.charAt(0);
	const text = raw.slice(1);
	if (marker === "+") {
		file.lines.push({ kind: "add", text, oldLine: cursor.oldLine, newLine: cursor.newLine });
		return { ...cursor, newLine: cursor.newLine + 1, newLeft: cursor.newLeft - 1 };
	}
	if (marker === "-") {
		file.lines.push({ kind: "remove", text, oldLine: cursor.oldLine, newLine: cursor.newLine });
		return { ...cursor, oldLine: cursor.oldLine + 1, oldLeft: cursor.oldLeft - 1 };
	}
	file.lines.push({ kind: "context", text, oldLine: cursor.oldLine, newLine: cursor.newLine });
	return {
		oldLine: cursor.oldLine + 1,
		newLine: cursor.newLine + 1,
		oldLeft: cursor.oldLeft - 1,
		newLeft: cursor.newLeft - 1,
	};
}
