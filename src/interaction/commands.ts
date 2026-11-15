// Forge command comments (design D4). Only the comment's first line counts, and
// only when it starts with `/livespec `. Tokens are split on whitespace; the rest
// of the line is free text. Parsing never throws.

import type { Difficulty, QuestionClass } from "./approver.ts";

export type Command =
	| { verb: "approve"; notes: string }
	| { verb: "changes"; notes: string }
	| { verb: "dismiss"; notes: string }
	| { verb: "choose"; option: string; notes: string }
	| { verb: "answer"; question: string; text: string; changes?: string; class?: QuestionClass }
	| { verb: "class"; question: string; class: QuestionClass }
	| { verb: "set"; unit: string; field: "difficulty"; value: Difficulty }
	| { verb: "set"; unit: string; field: "tags"; value: string[] };

export type ParseError = { error: string };

const PREFIX = "/livespec ";
const QUESTION_ID = /^Q[0-9]+$/;
const UNIT_ID = /^U[0-9]+$/;
const CLASSES: readonly string[] = ["blocking", "non-blocking"];
const DIFFICULTIES: readonly string[] = ["low", "medium", "high"];
const CHANGES_FLAG = "--changes";
const CLASS_FLAG = "--class";

/** Splits the first whitespace-separated token off `text`; `rest` is trimmed. */
function takeToken(text: string): { token: string; rest: string } {
	const trimmed = text.trimStart();
	const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
	if (!match) return { token: "", rest: "" };
	return { token: match[1], rest: match[2].trimEnd() };
}

function firstLine(body: string): string {
	const newline = body.indexOf("\n");
	const line = newline === -1 ? body : body.slice(0, newline);
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function parseChoose(rest: string): Command | ParseError {
	const { token: option, rest: notes } = takeToken(rest);
	if (!option) return { error: "choose needs an option id" };
	return { verb: "choose", option, notes };
}

/** `Q<n> <text> [--class blocking|non-blocking] [--changes <rest of line>]`. */
function parseAnswer(rest: string): Command | ParseError {
	const { token: question, rest: afterId } = takeToken(rest);
	if (!QUESTION_ID.test(question)) return { error: `answer needs a question id like Q1, got "${question}"` };

	const words: string[] = [];
	let remaining = afterId;
	let cls: QuestionClass | undefined;
	let changes: string | undefined;
	while (remaining) {
		const { token, rest: next } = takeToken(remaining);
		if (token === CHANGES_FLAG) {
			if (!next) return { error: "--changes needs <capability>/Requirement: <name>" };
			changes = next;
			break;
		}
		if (token === CLASS_FLAG) {
			const { token: value, rest: afterValue } = takeToken(next);
			if (!CLASSES.includes(value)) return { error: `--class must be blocking or non-blocking, got "${value}"` };
			cls = value as QuestionClass;
			remaining = afterValue;
			continue;
		}
		words.push(token);
		remaining = next;
	}
	if (words.length === 0) return { error: `answer ${question} needs answer text` };

	const command: Command = { verb: "answer", question, text: words.join(" ") };
	if (changes !== undefined) command.changes = changes;
	if (cls !== undefined) command.class = cls;
	return command;
}

function parseClass(rest: string): Command | ParseError {
	const { token: question, rest: afterId } = takeToken(rest);
	if (!QUESTION_ID.test(question)) return { error: `class needs a question id like Q1, got "${question}"` };
	const { token: value, rest: extra } = takeToken(afterId);
	if (!CLASSES.includes(value) || extra) return { error: "class needs exactly blocking or non-blocking" };
	return { verb: "class", question, class: value as QuestionClass };
}

function parseSet(rest: string): Command | ParseError {
	const { token: unit, rest: afterUnit } = takeToken(rest);
	if (!UNIT_ID.test(unit)) return { error: `set needs a unit id like U1, got "${unit}"` };
	const { token: field, rest: value } = takeToken(afterUnit);
	if (field === "difficulty") {
		if (!DIFFICULTIES.includes(value)) return { error: `difficulty must be low, medium or high, got "${value}"` };
		return { verb: "set", unit, field, value: value as Difficulty };
	}
	if (field === "tags") {
		const tags = value
			.split(",")
			.map((tag) => tag.trim())
			.filter((tag) => tag !== "");
		if (tags.length === 0) return { error: "set tags needs a comma-separated list" };
		return { verb: "set", unit, field, value: tags };
	}
	return { error: `set accepts difficulty or tags, got "${field}"` };
}

/**
 * Parses a forge comment body. Returns `undefined` when the first line (a trailing
 * `\r` stripped) does not start with `/livespec `, and `{ error }` when it does
 * but cannot be parsed.
 */
export function parseCommand(body: string): Command | ParseError | undefined {
	const line = firstLine(body);
	if (!line.startsWith(PREFIX)) return undefined;

	const { token: verb, rest } = takeToken(line.slice(PREFIX.length));
	switch (verb) {
		case "approve":
		case "dismiss":
			return { verb, notes: rest };
		case "changes":
			return rest ? { verb, notes: rest } : { error: "changes needs notes" };
		case "choose":
			return parseChoose(rest);
		case "answer":
			return parseAnswer(rest);
		case "class":
			return parseClass(rest);
		case "set":
			return parseSet(rest);
		default:
			return { error: `unknown command "${verb}"` };
	}
}
