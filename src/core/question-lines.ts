import { type Question, parseChange } from "./change.ts";
import { type Line, joinLines } from "./lines.ts";
import { replaceSection } from "./sections.ts";

export type QuestionClass = "blocking" | "non-blocking";

const ANSWER_SEP = " — Answer: ";

function singleLine(text: string, what: string): string {
	if (/[\r\n]/.test(text)) throw new Error(`${what} must be a single line`);
	return text.trim();
}

function findQuestion(questions: Question[], id: string): Question {
	const q = questions.find((x) => x.id === id);
	if (!q) throw new Error(`question ${id} not found`);
	return q;
}

function formatLine(q: { id: string; checked: boolean; text: string; answer?: string }, cls: QuestionClass): string {
	const tail = q.answer === undefined ? "" : `${ANSWER_SEP}${q.answer}`;
	return `- [${q.checked ? "x" : " "}] ${q.id} (${cls}): ${q.text}${tail}`;
}

const CLASS_TOKEN = /^- \[[ x]\] (Q\d+) \((?:non-blocking|blocking)\): /;

function rewriteRaw(body: string, id: string, next: (raw: string, q: Question) => string): string {
	const change = parseChange(body);
	const q = findQuestion(change.questions, id);
	const out = change.lines.slice();
	out[q.line] = { text: next(change.lines[q.line]!.text, q), eol: change.lines[q.line]!.eol };
	return joinLines(out);
}

/** Adds an open question numbered after the highest existing Q; creates `## Questions` when absent. */
export function appendQuestion(body: string, cls: QuestionClass, text: string): { body: string; id: string } {
	const clean = singleLine(text, "question text");
	const change = parseChange(body);
	const highest = Math.max(0, ...change.questions.map((q) => Number(q.id.slice(1))));
	const id = `Q${highest + 1}`;
	const line = formatLine({ id, checked: false, text: clean }, cls);
	const lines = change.lines;
	const start = lines.findIndex((l) => l.text === "## Questions");
	if (start === -1) return { body: replaceSection(body, "Questions", line), id };
	let end = start + 1;
	while (end < lines.length && !/^## /.test(lines[end]!.text)) end++;
	let at = end;
	while (at > start + 1 && lines[at - 1]!.text.trim() === "") at--;
	const eol = lines[0]!.eol === "\r\n" ? "\r\n" : "\n";
	const head: Line[] = lines.slice(0, at);
	const prev = head[head.length - 1]!;
	if (prev.eol === "") head[head.length - 1] = { text: prev.text, eol };
	return { body: joinLines([...head, { text: line, eol }, ...lines.slice(at)]), id };
}

/** Ticks the question and records the answer; the class may change with it. Question text bytes are kept. */
export function answerQuestion(body: string, id: string, cls: QuestionClass, answer: string): string {
	const clean = singleLine(answer, "answer");
	return rewriteRaw(body, id, (raw) => {
		const head = CLASS_TOKEN.exec(raw)![0];
		const rest = raw.slice(head.length);
		const at = rest.lastIndexOf(ANSWER_SEP);
		const text = at === -1 ? rest.trimEnd() : rest.slice(0, at);
		return `- [x] ${id} (${cls}): ${text}${ANSWER_SEP}${clean}`;
	});
}

/** Changes only the class token of the raw question line. */
export function reclassifyQuestion(body: string, id: string, cls: QuestionClass): string {
	return rewriteRaw(body, id, (raw) => raw.replace(/^(- \[[ x]\] Q\d+ \()(?:non-blocking|blocking)(\): )/, `$1${cls}$2`));
}
