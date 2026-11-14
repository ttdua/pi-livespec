export type GitDiffFile = {
	oldPath: string;
	newPath: string;
	newFile: boolean;
	deletedFile: boolean;
	renamed: boolean;
};

const HEADER = "diff --git ";
const ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, "\\": 92 };
const encoder = new TextEncoder();

/** Decodes a git C-quoted string starting at `start` (which must be `"`); returns the value and the index after it. */
function unquote(text: string, start: number): { value: string; end: number } {
	const bytes: number[] = [];
	let i = start + 1;
	while (i < text.length && text[i] !== '"') {
		if (text[i] !== "\\") {
			const ch = String.fromCodePoint(text.codePointAt(i) as number);
			bytes.push(...encoder.encode(ch));
			i += ch.length;
			continue;
		}
		const next = text[i + 1] ?? "";
		if (/[0-7]/.test(next)) {
			bytes.push(parseInt(text.slice(i + 1, i + 4), 8));
			i += 4;
			continue;
		}
		const code = ESCAPES[next];
		bytes.push(code ?? next.charCodeAt(0));
		i += 2;
	}
	return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 };
}

/** Reads a path token: C-quoted when it starts with `"`, otherwise the rest of the text. */
function readPath(text: string): string {
	return text.startsWith('"') ? unquote(text, 0).value : text.replace(/\t$/, "");
}

/** Splits `a/<old> b/<new>` on the header; ambiguous unquoted names are resolved by the matching-half rule. */
function parseHeaderPaths(rest: string): { oldPath: string; newPath: string } {
	if (rest.startsWith('"')) {
		const a = unquote(rest, 0);
		const b = unquote(rest, a.end + 1);
		return { oldPath: a.value.slice(2), newPath: b.value.slice(2) };
	}
	let fallback: { oldPath: string; newPath: string } | undefined;
	for (let i = rest.indexOf(" b/"); i !== -1; i = rest.indexOf(" b/", i + 1)) {
		const oldPath = rest.slice(2, i);
		const newPath = rest.slice(i + 3);
		if (oldPath === newPath) return { oldPath, newPath };
		fallback ??= { oldPath, newPath };
	}
	return fallback ?? { oldPath: rest.slice(2), newPath: rest.slice(2) };
}

/** Splits a `git diff` output into one record per file; metadata is read only before the first hunk. */
export function parseGitDiff(diff: string): GitDiffFile[] {
	const files: GitDiffFile[] = [];
	let file: GitDiffFile | undefined;
	let inHunk = false;
	for (const raw of diff.split(/\r?\n/)) {
		if (raw.startsWith(HEADER)) {
			const paths = parseHeaderPaths(raw.slice(HEADER.length));
			file = { ...paths, newFile: false, deletedFile: false, renamed: false };
			files.push(file);
			inHunk = false;
			continue;
		}
		if (!file) continue;
		if (raw.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (inHunk) continue;
		if (raw.startsWith("new file mode")) file.newFile = true;
		else if (raw.startsWith("deleted file mode")) file.deletedFile = true;
		else if (raw.startsWith("rename from ")) {
			file.oldPath = readPath(raw.slice("rename from ".length));
			file.renamed = true;
		} else if (raw.startsWith("rename to ")) {
			file.newPath = readPath(raw.slice("rename to ".length));
			file.renamed = true;
		} else if (raw.startsWith("--- ")) {
			if (raw === "--- /dev/null") file.newFile = true;
			else file.oldPath = readPath(raw.slice(4)).slice(2);
		} else if (raw.startsWith("+++ ")) {
			if (raw === "+++ /dev/null") file.deletedFile = true;
			else file.newPath = readPath(raw.slice(4)).slice(2);
		}
	}
	return files;
}
