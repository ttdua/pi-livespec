/** Returns an error message for an unbalanced `{`/`[` (or stray `}`), else null. */
export function validateGlob(pattern: string): string | null {
	let braces = 0;
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "\\") {
			i++;
		} else if (c === "[") {
			const end = classEnd(pattern, i);
			if (end === -1) return `unclosed "[" at position ${i}`;
			i = end;
		} else if (c === "{") {
			braces++;
		} else if (c === "}") {
			if (braces === 0) return `unmatched "}" at position ${i}`;
			braces--;
		}
	}
	return braces > 0 ? 'unclosed "{"' : null;
}

export function matchGlob(pattern: string, path: string): boolean {
	if (validateGlob(pattern) !== null) return false;
	return new RegExp(`^${translate(pattern)}$`).test(path);
}

function classEnd(p: string, open: number): number {
	let i = open + 1;
	if (p[i] === "!" || p[i] === "^") i++;
	if (p[i] === "]") i++;
	for (; i < p.length; i++) if (p[i] === "]") return i;
	return -1;
}

function escapeChar(c: string): string {
	return /[.*+?^${}()|[\]\\/]/.test(c) ? `\\${c}` : c;
}

function translate(p: string): string {
	let out = "";
	let depth = 0;
	for (let i = 0; i < p.length; i++) {
		const c = p[i] as string;
		if (c === "*") {
			if (p[i + 1] === "*") {
				i++;
				if (p[i + 1] === "/") {
					i++;
					out += "(?:.*/)?";
				} else {
					out += ".*";
				}
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") {
			out += "[^/]";
		} else if (c === "[") {
			const end = classEnd(p, i);
			let body = p.slice(i + 1, end);
			let neg = "";
			if (body[0] === "!" || body[0] === "^") {
				neg = "^";
				body = body.slice(1);
			}
			out += `[${neg}${body.replace(/\\/g, "\\\\")}]`;
			i = end;
		} else if (c === "{") {
			depth++;
			out += "(?:";
		} else if (c === "}") {
			depth--;
			out += ")";
		} else if (c === "," && depth > 0) {
			out += "|";
		} else if (c === "\\" && i + 1 < p.length) {
			i++;
			out += escapeChar(p[i] as string);
		} else {
			out += escapeChar(c);
		}
	}
	return out;
}
