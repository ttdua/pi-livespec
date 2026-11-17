// A dependency-free reader for POSIX shell text (design D7). It reduces a script
// to simple commands in source order; it never runs anything. It reads only as
// much syntax as the guard needs: quotes, escapes, comments, list and pipe
// operators, subshells and groups, redirections, here-documents and
// `$(…)`/backtick substitutions (kept as raw text for the caller to reparse).

export type Word = { text: string; quoted: boolean; expansion: boolean };
export type Redirect = { op: string; target: Word };
export type ShellCommand = { words: Word[]; assignments: string[]; redirects: Redirect[]; substitutions: string[] };

/** `escaped`: a `\` quoted part of the word, which (like quotes) makes a here-document delimiter literal. */
type WordToken = { kind: "word"; word: Word; substitutions: string[]; assignable: boolean; escaped: boolean };
type OpToken = { kind: "op"; op: string };
type RedirectToken = { kind: "redirect"; op: string };
type Token = WordToken | OpToken | RedirectToken;

const BLANKS = new Set([" ", "\t", "\r"]);
const WORD_ENDS = new Set([";", "&", "|", "(", ")", "<", ">", "\n"]);
const REDIRECT_OP = /(?:\d|&)?(?:>>|>&|>\||<<-|<<<|<<|<&|<>|>|<)/y;
const LIST_OP = /&&|\|\||;;|\|&|[;&|()]/y;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PARAMETER_START = /[A-Za-z0-9_@*#?$!-]/;
const PARAMETER_NAME = /[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-]/y;
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\"]);
/** Words that open or close a compound command; dropped at the start of a command. */
const RESERVED_LEADING = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}"]);

class Unreadable extends Error {}

/** The simple commands of `text` in source order, or `"unreadable"` when quotes, parentheses or substitutions do not balance. */
export function parseShell(text: string): ShellCommand[] | "unreadable" {
	try {
		return assemble(new Lexer(text).run());
	} catch (error) {
		if (error instanceof Unreadable) return "unreadable";
		throw error;
	}
}

/** A word under construction: its decoded text and what kinds of syntax built it. */
class WordBuilder {
	text = "";
	quoted = false;
	expansion = false;
	escaped = false;
	readonly substitutions: string[] = [];
	private firstSpecial: number | undefined;

	/** Records where the first quote, escape or expansion starts, for assignment detection. */
	markSpecial(): void {
		this.firstSpecial ??= this.text.length;
	}

	token(): WordToken {
		const assignment = ASSIGNMENT.exec(this.text);
		const assignable = assignment !== null && assignment[0].length <= (this.firstSpecial ?? Number.POSITIVE_INFINITY);
		return { kind: "word", word: { text: this.text, quoted: this.quoted, expansion: this.expansion }, substitutions: this.substitutions, assignable, escaped: this.escaped };
	}
}

class Lexer {
	private i = 0;
	private readonly tokens: Token[] = [];
	private heredocs: { delimiter: string; stripTabs: boolean; token: WordToken }[] = [];
	private heredocOp: string | undefined;

	// Not readonly: line continuations after `$` are removed in place (dropContinuationsAfterDollar).
	constructor(private s: string) {}

	run(): Token[] {
		while (this.i < this.s.length) this.step();
		return this.tokens;
	}

	private step(): void {
		const c = this.s[this.i];
		if (c === undefined) return;
		if (BLANKS.has(c)) this.i++;
		else if (c === "\\" && this.s[this.i + 1] === "\n") this.i += 2;
		else if (c === "#") this.skipComment();
		else if (c === "\n") this.newline();
		else if (!this.readOperator(REDIRECT_OP, "redirect") && !this.readOperator(LIST_OP, "op")) this.pushWord(this.readWord());
	}

	private skipComment(): void {
		const end = this.s.indexOf("\n", this.i);
		this.i = end < 0 ? this.s.length : end;
	}

	private newline(): void {
		this.i++;
		this.tokens.push({ kind: "op", op: ";" });
		this.skipHeredocBodies();
	}

	private readOperator(pattern: RegExp, kind: "redirect" | "op"): boolean {
		pattern.lastIndex = this.i;
		const match = pattern.exec(this.s);
		if (!match) return false;
		const op = match[0];
		this.i += op.length;
		this.tokens.push({ kind, op });
		if (op.endsWith("<<") || op.endsWith("<<-")) this.heredocOp = op;
		return true;
	}

	private pushWord(token: WordToken): void {
		if (this.heredocOp !== undefined) {
			this.heredocs.push({ delimiter: token.word.text, stripTabs: this.heredocOp.endsWith("-"), token });
			this.heredocOp = undefined;
		}
		this.tokens.push(token);
	}

	/**
	 * Here-document bodies are data, not commands: each is skipped up to its
	 * delimiter line. With an unquoted delimiter the shell still runs the body's
	 * substitutions, so they are kept on the redirect target's token.
	 */
	private skipHeredocBodies(): void {
		for (const { delimiter, stripTabs, token } of this.heredocs) {
			const lines: string[] = [];
			while (this.i < this.s.length) {
				const nl = this.s.indexOf("\n", this.i);
				const end = nl < 0 ? this.s.length : nl;
				const line = this.s.slice(this.i, end);
				this.i = end + 1;
				if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
				lines.push(line);
			}
			if (!token.word.quoted && !token.escaped) token.substitutions.push(...substitutionsIn(lines.join("\n")));
		}
		this.heredocs = [];
	}

	private readWord(): WordToken {
		const w = new WordBuilder();
		for (let c = this.s[this.i]; c !== undefined && !BLANKS.has(c) && !WORD_ENDS.has(c); c = this.s[this.i]) {
			if (c === "'") this.readSingle(w);
			else if (c === '"') this.readDouble(w);
			else if (c === "\\") this.readEscape(w);
			else if (c === "$") this.readDollar(w);
			else if (c === "`") this.readBacktick(w);
			else {
				w.text += c;
				this.i++;
			}
		}
		return w.token();
	}

	private readSingle(w: WordBuilder): void {
		const end = this.s.indexOf("'", this.i + 1);
		if (end < 0) throw new Unreadable();
		w.markSpecial();
		w.quoted = true;
		w.text += this.s.slice(this.i + 1, end);
		this.i = end + 1;
	}

	/** A backslash-newline is a line continuation, removed before words are read; it quotes nothing. */
	private readEscape(w: WordBuilder): void {
		const next = this.s[this.i + 1];
		this.i += 2;
		if (next === "\n") return;
		w.markSpecial();
		w.escaped = true;
		w.text += next ?? "\\";
	}

	private readDouble(w: WordBuilder): void {
		w.markSpecial();
		w.quoted = true;
		this.i++;
		for (;;) {
			const c = this.s[this.i];
			if (c === undefined) throw new Unreadable();
			if (c === '"') break;
			if (c === "$") this.readDollar(w);
			else if (c === "`") this.readBacktick(w);
			else if (c === "\\" && this.s[this.i + 1] === "\n") this.i += 2;
			else if (c === "\\" && DOUBLE_QUOTE_ESCAPES.has(this.s[this.i + 1] ?? "")) {
				w.text += this.s[this.i + 1];
				this.i += 2;
			} else {
				w.text += c;
				this.i++;
			}
		}
		this.i++;
	}

	private readDollar(w: WordBuilder): void {
		this.dropContinuationsAfterDollar();
		const next = this.s[this.i + 1] ?? "";
		if (next === "(") return this.readParenExpansion(w);
		if (next === "{") return this.readBraceExpansion(w);
		if (!PARAMETER_START.test(next)) {
			w.text += "$";
			this.i++;
			return;
		}
		PARAMETER_NAME.lastIndex = this.i + 1;
		const name = PARAMETER_NAME.exec(this.s)?.[0] ?? next;
		this.expand(w, `$${name}`, this.i + 1 + name.length);
	}

	/** `$(…)` is a substitution; `$((…))` is arithmetic, whose own substitutions are kept. */
	private readParenExpansion(w: WordBuilder): void {
		const close = scanParens(this.s, this.i + 1);
		const raw = this.s.slice(this.i, close + 1);
		w.substitutions.push(...dollarSubstitutions(raw));
		this.expand(w, raw, close + 1);
	}

	/** `${…}`: the operand of `${X:-…}` and similar forms may hold substitutions. */
	private readBraceExpansion(w: WordBuilder): void {
		const close = scanBrace(this.s, this.i + 1);
		const raw = this.s.slice(this.i, close + 1);
		w.substitutions.push(...dollarSubstitutions(raw));
		this.expand(w, raw, close + 1);
	}

	private readBacktick(w: WordBuilder): void {
		const close = scanBacktick(this.s, this.i);
		const raw = this.s.slice(this.i + 1, close).replace(/\\([`$\\])/g, "$1");
		w.substitutions.push(raw);
		this.expand(w, `\`${raw}\``, close + 1);
	}

	/** `$\\<newline>(` is `$(` to the shell: remove the line continuations right after `$`. */
	private dropContinuationsAfterDollar(): void {
		while (this.s.startsWith("\\\n", this.i + 1)) this.s = this.s.slice(0, this.i + 1) + this.s.slice(this.i + 3);
	}

	private expand(w: WordBuilder, raw: string, end: number): void {
		w.markSpecial();
		w.expansion = true;
		w.text += raw;
		this.i = end;
	}
}

/**
 * The substitutions a `$(…)`, `$((…))` or `${…}` text runs: a command
 * substitution is itself; arithmetic and parameter expansions yield the
 * substitutions nested in their text.
 */
function dollarSubstitutions(raw: string): string[] {
	if (raw.startsWith("$((")) return substitutionsIn(raw.slice(3, -2));
	if (raw.startsWith("$(")) return [raw.slice(2, -1)];
	return substitutionsIn(raw.slice(2, -1));
}

/**
 * Every `$(…)` and backtick substitution in text the shell expands but does not
 * split into commands (here-document bodies, `${…}` operands, arithmetic).
 * Quotes are not special here, which can only find more substitutions, never fewer.
 */
function substitutionsIn(raw: string): string[] {
	const text = joinContinuations(raw);
	const found: string[] = [];
	for (let j = 0; j < text.length; j++) {
		const c = text[j];
		if (c === "\\") j++;
		else if (c === "`") {
			const close = scanBacktick(text, j);
			found.push(text.slice(j + 1, close).replace(/\\([`$\\])/g, "$1"));
			j = close;
		} else if (c === "$" && (text[j + 1] === "(" || text[j + 1] === "{")) {
			const close = text[j + 1] === "(" ? scanParens(text, j + 1) : scanBrace(text, j + 1);
			found.push(...dollarSubstitutions(text.slice(j, close + 1)));
			j = close;
		}
	}
	return found;
}

/** Removes backslash-newline line continuations; an escaped backslash stays escaped. */
function joinContinuations(text: string): string {
	let out = "";
	for (let j = 0; j < text.length; j++) {
		const c = text[j] as string;
		if (c !== "\\") out += c;
		else if (text[j + 1] === "\n") j++;
		else {
			out += text.slice(j, j + 2);
			j++;
		}
	}
	return out;
}

/**
 * Index of the `}` that closes the `${` whose `{` is at `open`, skipping escapes,
 * double quotes and nested substitutions. Only `${` nests; a bare `{` is literal.
 */
function scanBrace(s: string, open: number): number {
	let depth = 1;
	for (let j = open + 1; j < s.length; j++) {
		const c = s[j];
		if (c === "$" && s[j + 1] === "{") {
			depth++;
			j++;
		} else if (c === "}" && --depth === 0) return j;
		else if (c === "\\") j++;
		else if (c === '"') j = scanDouble(s, j);
		else if (c === "`") j = scanBacktick(s, j);
		else if (c === "$" && s[j + 1] === "(") j = scanParens(s, j + 1);
	}
	throw new Unreadable();
}

/** Index of the `)` that closes the `(` at `open`, skipping quoted text and nested substitutions. */
function scanParens(s: string, open: number): number {
	let depth = 0;
	for (let j = open; j < s.length; j++) {
		const c = s[j];
		if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return j;
		else if (c === "\\") j++;
		else if (c === "'") j = closingIndex(s, "'", j);
		else if (c === '"') j = scanDouble(s, j);
		else if (c === "`") j = scanBacktick(s, j);
	}
	throw new Unreadable();
}

function scanDouble(s: string, open: number): number {
	for (let j = open + 1; j < s.length; j++) {
		const c = s[j];
		if (c === '"') return j;
		if (c === "\\") j++;
		else if (c === "$" && s[j + 1] === "(") j = scanParens(s, j + 1);
		else if (c === "`") j = scanBacktick(s, j);
	}
	throw new Unreadable();
}

function scanBacktick(s: string, open: number): number {
	for (let j = open + 1; j < s.length; j++) {
		if (s[j] === "\\") j++;
		else if (s[j] === "`") return j;
	}
	throw new Unreadable();
}

function closingIndex(s: string, quote: string, open: number): number {
	const close = s.indexOf(quote, open + 1);
	if (close < 0) throw new Unreadable();
	return close;
}

/** Builds commands from tokens; mutation stays local to the commands under construction. */
function assemble(tokens: Token[]): ShellCommand[] {
	const commands: ShellCommand[] = [];
	let current = emptyCommand();
	let depth = 0;
	// The command a following redirect belongs to after `)` or `}` closes a body.
	let closed: ShellCommand | undefined;
	const finish = (): void => {
		if (hasContent(current)) commands.push(current);
		current = emptyCommand();
	};
	for (let k = 0; k < tokens.length; k++) {
		const t = tokens[k] as Token;
		if (t.kind === "op") {
			if (t.op === "(") depth++;
			if (t.op === ")" && --depth < 0) throw new Unreadable();
			finish();
			closed = t.op === ")" ? commands.at(-1) : undefined;
		} else if (t.kind === "redirect") {
			const target = tokens[++k];
			if (target?.kind !== "word") throw new Unreadable();
			const owner = !hasContent(current) && closed ? closed : current;
			owner.redirects.push({ op: t.op, target: target.word });
			owner.substitutions.push(...target.substitutions);
		} else if (isLeadingReserved(current, t)) {
			if (t.word.text === "}") closed = commands.at(-1);
		} else {
			addWord(current, t);
		}
	}
	if (depth !== 0) throw new Unreadable();
	finish();
	return commands;
}

function addWord(cmd: ShellCommand, t: WordToken): void {
	if (cmd.words.length === 0 && t.assignable) cmd.assignments.push(t.word.text);
	else cmd.words.push(t.word);
	cmd.substitutions.push(...t.substitutions);
}

function isLeadingReserved(cmd: ShellCommand, t: WordToken): boolean {
	return cmd.words.length === 0 && cmd.assignments.length === 0 && !t.word.quoted && !t.word.expansion && RESERVED_LEADING.has(t.word.text);
}

function emptyCommand(): ShellCommand {
	return { words: [], assignments: [], redirects: [], substitutions: [] };
}

function hasContent(cmd: ShellCommand): boolean {
	return cmd.words.length > 0 || cmd.assignments.length > 0 || cmd.redirects.length > 0;
}
