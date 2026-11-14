export type Eol = "\n" | "\r\n" | "";
export type Line = { text: string; eol: Eol };

export function splitLines(s: string): Line[] {
	const lines: Line[] = [];
	let start = 0;
	while (start < s.length) {
		const nl = s.indexOf("\n", start);
		if (nl === -1) {
			lines.push({ text: s.slice(start), eol: "" });
			break;
		}
		const crlf = nl > start && s[nl - 1] === "\r";
		lines.push({ text: s.slice(start, crlf ? nl - 1 : nl), eol: crlf ? "\r\n" : "\n" });
		start = nl + 1;
	}
	return lines;
}

export function joinLines(lines: Line[]): string {
	return lines.map((l) => l.text + l.eol).join("");
}
