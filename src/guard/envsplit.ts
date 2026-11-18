// `env -S` has its own word splitting (GNU and BSD), distinct from the shell:
// unquoted whitespace and `\_` separate words, backslash escapes are decoded,
// quotes group text and `${VAR}` is expanded by env itself.

const SEPARATING_ESCAPES = new Set(["_", "t", "n", "r", "f", "v"]);
const LITERAL_ESCAPES = new Set(["\\", '"', "'", "$", "#"]);

/**
 * The words `env -S <text>` runs, or "unreadable" for `${…}`, an unknown
 * escape or an unterminated quote. A control-character escape (`\t`) is treated
 * as a separator: env may keep it inside a word, but the guard fails closed.
 */
export function splitEnvString(text: string): string[] | "unreadable" {
	const words: string[] = [];
	let word: string | undefined;
	let quote: string | undefined;
	const push = (c: string) => {
		word = (word ?? "") + c;
	};
	const flush = () => {
		if (word !== undefined) words.push(word);
		word = undefined;
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		if (c === "$" && text[i + 1] === "{") return "unreadable";
		if (c === "\\") {
			const next = text[++i];
			if (next === undefined) return "unreadable";
			if (next === "c") break;
			if (LITERAL_ESCAPES.has(next)) push(next);
			else if (SEPARATING_ESCAPES.has(next)) {
				if (quote) push(next === "_" ? " " : "\\" + next);
				else flush();
			} else return "unreadable";
		} else if (quote) {
			if (c === quote) quote = undefined;
			else push(c);
		} else if (c === "'" || c === '"') {
			quote = c;
			word ??= "";
		} else if (/\s/.test(c)) flush();
		else if (c === "#" && word === undefined) break;
		else push(c);
	}
	if (quote) return "unreadable";
	flush();
	return words;
}
