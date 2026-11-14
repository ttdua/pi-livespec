type Compiled = { ok: true; regex: RegExp } | { ok: false; error: string };

class GlobSyntaxError extends SyntaxError {}

/** Returns an error message for an invalid glob, else null. */
export function validateGlob(pattern: string): string | null {
	const compiled = compileGlob(pattern);
	return compiled.ok ? null : compiled.error;
}

/** Returns false for an invalid pattern; never throws on pattern input. */
export function matchGlob(pattern: string, path: string): boolean {
	const compiled = compileGlob(pattern);
	return compiled.ok && compiled.regex.test(path);
}

function compileGlob(pattern: string): Compiled {
	try {
		return { ok: true, regex: new RegExp(`^${translate(pattern)}$`) };
	} catch (err) {
		if (err instanceof SyntaxError) return { ok: false, error: err.message };
		throw err;
	}
}

function classEnd(p: string, open: number): number {
	let i = open + 1;
	if (p[i] === "!" || p[i] === "^") i++;
	if (p[i] === "]") i++;
	for (; i < p.length; i++) if (p[i] === "]") return i;
	return -1;
}

function checkRanges(body: string, open: number): void {
	let j = 0;
	while (j < body.length) {
		if (body[j + 1] === "-" && j + 2 < body.length) {
			if (body.charCodeAt(j) > body.charCodeAt(j + 2)) {
				throw new GlobSyntaxError(
					`out-of-order range "${body[j]}-${body[j + 2]}" in "[" at position ${open}`,
				);
			}
			j += 3;
		} else {
			j++;
		}
	}
}

function escapeChar(c: string): string {
	return /[.*+?^${}()|[\]\\/]/.test(c) ? `\\${c}` : c;
}

/**
 * Translates a glob into regex source. Throws GlobSyntaxError on invalid input.
 * Character classes are guarded by `(?!/)` so they never match a separator,
 * including negated classes and ranges spanning `/`.
 */
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
			if (end === -1) throw new GlobSyntaxError(`unclosed "[" at position ${i}`);
			let body = p.slice(i + 1, end);
			let neg = "";
			if (body[0] === "!" || body[0] === "^") {
				neg = "^";
				body = body.slice(1);
			}
			checkRanges(body, i);
			out += `(?!/)[${neg}${body.replace(/\\/g, "\\\\")}]`;
			i = end;
		} else if (c === "{") {
			depth++;
			out += "(?:";
		} else if (c === "}") {
			if (depth === 0) throw new GlobSyntaxError(`unmatched "}" at position ${i}`);
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
	if (depth > 0) throw new GlobSyntaxError('unclosed "{"');
	return out;
}
