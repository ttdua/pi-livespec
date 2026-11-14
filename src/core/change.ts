import { type Line, joinLines, splitLines } from "./lines.ts";

export type Question = {
	id: string;
	kind: "blocking" | "non-blocking";
	text: string;
	checked: boolean;
	answer?: string;
	line: number;
};

export type Unit = {
	id: string;
	title: string;
	covers: string[];
	difficulty?: string;
	tags?: string[];
	files: string[];
	doneMeans: { label: string; text: string }[];
	scenarios: { label: string; ref: string }[];
	depends: string[];
	verify?: string;
	kind?: "refactor";
	done: boolean;
	/** Index into `lines` of the status line, or -1 when absent. */
	statusLine: number;
	/** Raw text of the status line ("" when absent); may be malformed, the validator reports it. */
	statusText: string;
	/** Index of the `### U<n>` heading line. */
	startLine: number;
	/** Index of the last line of the block (inclusive, trailing blank lines excluded). */
	endLine: number;
	/** Field name to its raw value lines (trimmed), in source order; feeds the digest. */
	raw: Record<string, string[]>;
};

export type Change = {
	header: {
		base?: string;
		branch?: string;
		initiative?: string;
		depends?: string[];
		capabilities?: { new: string[]; modified: string[] };
		productImpact?: string;
		pr?: string;
	};
	questions: Question[];
	units: Unit[];
	durableDocs: { file: string; status: string }[];
	lines: Line[];
};


const UNIT_HEADING = /^### (U\d+) — (.*)$/;
const STATUS = /^- \[[ xX]\] \S.*$/;
const FIELD = /^(Covers|Difficulty|Tags|Files|Done means|Scenarios|Depends|Verify|Kind):[ \t]*(.*?)\s*$/;
const LABELLED = /^- \[([^\]\s][^\]]*)\]\s+(.*?)\s*$/;
const QUESTION = /^- \[( |x)\] (Q\d+) \((blocking|non-blocking)\): (.*)$/;
const ANSWER_SEP = " — Answer: ";

function isH2(text: string): boolean {
	return /^## /.test(text);
}

function splitList(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "" && s !== "—");
}

function bracketList(value: string): string[] {
	const m = /^\[(.*)\]$/.exec(value.trim());
	return splitList(m ? (m[1] as string) : value);
}

function parseHeader(lines: Line[], end: number): Change["header"] {
	const header: Change["header"] = {};
	for (let i = 0; i < end; i++) {
		const m = /^([A-Za-z ]+):[ \t]*(.*?)\s*$/.exec((lines[i] as Line).text);
		if (!m) continue;
		const value = m[2] as string;
		switch (m[1]) {
			case "Base":
				header.base = value;
				break;
			case "Branch":
				header.branch = value;
				break;
			case "Initiative":
				header.initiative = value;
				break;
			case "Depends":
				header.depends = splitList(value);
				break;
			case "Capabilities": {
				const c = /^new \[(.*?)\],\s*modified \[(.*?)\]$/.exec(value);
				if (c) header.capabilities = { new: splitList(c[1] as string), modified: splitList(c[2] as string) };
				break;
			}
			case "Product impact":
				header.productImpact = value;
				break;
			case "PR":
				header.pr = value;
				break;
		}
	}
	return header;
}

function parseQuestion(text: string, line: number): Question | undefined {
	const m = QUESTION.exec(text);
	if (!m) return undefined;
	const rest = m[4] as string;
	const at = rest.lastIndexOf(ANSWER_SEP);
	const q: Question = {
		id: m[2] as string,
		kind: m[3] as Question["kind"],
		text: (at === -1 ? rest : rest.slice(0, at)).trim(),
		checked: m[1] === "x",
		line,
	};
	if (at !== -1) q.answer = rest.slice(at + ANSWER_SEP.length).trim();
	return q;
}

function parseUnit(lines: Line[], start: number, end: number): Unit {
	const head = UNIT_HEADING.exec((lines[start] as Line).text);
	// The status line is the block's last line; any other checkbox line is a list item.
	const statusLine = STATUS.test((lines[end] as Line).text) ? end : -1;
	const statusText = statusLine === -1 ? "" : (lines[statusLine] as Line).text;
	const unit: Unit = {
		id: head?.[1] as string,
		title: (head?.[2] as string).trim(),
		covers: [],
		files: [],
		doneMeans: [],
		scenarios: [],
		depends: [],
		done: statusText.startsWith("- [x]"),
		statusLine,
		statusText,
		startLine: start,
		endLine: end,
		raw: {},
	};
	let list: "Done means" | "Scenarios" | undefined;
	for (let i = start + 1; i <= end; i++) {
		if (i === statusLine) continue;
		const text = (lines[i] as Line).text;
		const f = FIELD.exec(text);
		if (f) {
			applyField(unit, f[1] as string, f[2] as string);
			list = f[1] === "Done means" || f[1] === "Scenarios" ? f[1] : undefined;
			continue;
		}
		const item = LABELLED.exec(text);
		if (list && item) {
			const label = item[1] as string;
			const rest = item[2] as string;
			if (list === "Done means") unit.doneMeans.push({ label, text: rest });
			else unit.scenarios.push({ label, ref: rest });
			(unit.raw[list] ??= []).push(text.trimEnd());
		}
	}
	return unit;
}

function applyField(unit: Unit, name: string, value: string): void {
	switch (name) {
		case "Covers":
			unit.covers = splitList(value);
			break;
		case "Difficulty":
			unit.difficulty = value;
			break;
		case "Tags":
			unit.tags = bracketList(value);
			break;
		case "Files":
			unit.files = splitList(value);
			break;
		case "Depends":
			unit.depends = splitList(value);
			break;
		case "Verify": {
			const m = /^`(.*)`$/.exec(value);
			unit.verify = m ? (m[1] as string) : value;
			break;
		}
		case "Kind":
			if (value === "refactor") unit.kind = "refactor";
			break;
	}
	if (name !== "Done means" && name !== "Scenarios") unit.raw[name] = [value];
	else unit.raw[name] = [];
}

function parseUnits(lines: Line[], from: number, to: number): Unit[] {
	const units: Unit[] = [];
	const starts: number[] = [];
	for (let i = from; i < to; i++) if (UNIT_HEADING.test((lines[i] as Line).text)) starts.push(i);
	starts.forEach((start, k) => {
		let end = (starts[k + 1] ?? to) - 1;
		while (end > start && (lines[end] as Line).text.trim() === "") end--;
		units.push(parseUnit(lines, start, end));
	});
	return units;
}

function parseDurableRow(text: string): { file: string; status: string } | undefined {
	if (!text.startsWith("|")) return undefined;
	const cells = text.split("|").slice(1, -1).map((c) => c.trim());
	if (cells.length < 2 || /^-+$/.test(cells[0] as string) || cells[0] === "File") return undefined;
	return { file: cells[0] as string, status: cells[1] as string };
}

export function parseChange(text: string): Change {
	const lines = splitLines(text);
	const sections = new Map<string, [number, number]>();
	let firstH2 = lines.length;
	let current: string | undefined;
	lines.forEach((l, i) => {
		if (!isH2(l.text)) return;
		if (current) (sections.get(current) as [number, number])[1] = i;
		firstH2 = Math.min(firstH2, i);
		current = l.text.slice(3).trim();
		sections.set(current, [i + 1, lines.length]);
	});
	const range = (name: string): [number, number] => sections.get(name) ?? [0, 0];
	const questions: Question[] = [];
	const [qs, qe] = range("Questions");
	for (let i = qs; i < qe; i++) {
		const q = parseQuestion((lines[i] as Line).text, i);
		if (q) questions.push(q);
	}
	const durableDocs: Change["durableDocs"] = [];
	const [ds, de] = range("Durable docs");
	for (let i = ds; i < de; i++) {
		const row = parseDurableRow((lines[i] as Line).text);
		if (row) durableDocs.push(row);
	}
	const [us, ue] = range("Units");
	return { header: parseHeader(lines, firstH2), questions, units: parseUnits(lines, us, ue), durableDocs, lines };
}

export function serializeChange(c: Change): string {
	return joinLines(c.lines);
}
