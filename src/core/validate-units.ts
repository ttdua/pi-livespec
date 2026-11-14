import type { Change, Unit } from "./change.ts";
import type { Result } from "./result.ts";

const COVERS = /^[a-z0-9][a-z0-9-]*\/Requirement: \S/;
const LABELLED = /^- \[[^\]\s][^\]]*\]\s+\S/;
const SINGLE_COMMAND = /^`[^`]+`$/;
const DIFFICULTIES = ["low", "medium", "high"];
const REQUIRED = ["Covers", "Difficulty", "Tags", "Files", "Done means", "Scenarios", "Depends", "Verify"];

function issue(code: string, u: Unit, message: string): Result {
	return { code, severity: "error", section: u.id, line: u.startLine + 1, message: `${u.id}: ${message}` };
}

/** Lines of a Done means / Scenarios list that are list items without a `[label]`. */
function unlabelledItems(c: Change, u: Unit): Map<string, number> {
	const bad = new Map<string, number>();
	let list: string | undefined;
	for (let i = u.startLine + 1; i <= u.endLine; i++) {
		if (i === u.statusLine) continue;
		const text = c.lines[i]?.text ?? "";
		const f = /^([A-Za-z ]+):/.exec(text);
		if (f) list = f[1] === "Done means" || f[1] === "Scenarios" ? f[1] : undefined;
		else if (list && /^- /.test(text) && !LABELLED.test(text) && !bad.has(list)) bad.set(list, i + 1);
	}
	return bad;
}

function checkFields(c: Change, u: Unit, out: Result[]): void {
	for (const name of REQUIRED) {
		if (!(name in u.raw)) out.push(issue("units-format", u, `missing field ${name}`));
	}
	for (const cov of u.covers) {
		if (!COVERS.test(cov)) out.push(issue("units-format", u, `Covers entry "${cov}" must be <capability>/Requirement: <name>`));
	}
	if ("Covers" in u.raw && u.covers.length === 0) out.push(issue("units-format", u, "Covers is empty"));
	if ("Files" in u.raw && u.files.length === 0) out.push(issue("units-format", u, "Files is empty"));
	if (u.difficulty !== undefined && !DIFFICULTIES.includes(u.difficulty)) {
		out.push(issue("units-format", u, `Difficulty "${u.difficulty}" must be low, medium or high`));
	}
	if ("Tags" in u.raw && !/^\[.*\]$/.test(u.raw.Tags?.[0] ?? "")) {
		out.push(issue("units-format", u, "Tags must be a bracketed list, e.g. [a, b] or []"));
	}
	if (u.verify !== undefined && !SINGLE_COMMAND.test(u.raw.Verify?.[0] ?? "")) {
		out.push(issue("units-format", u, "Verify must be exactly one command in backticks"));
	}
	if ("Kind" in u.raw && u.kind === undefined) out.push(issue("units-format", u, "Kind must be refactor"));
	if ("Done means" in u.raw && u.doneMeans.length === 0) out.push(issue("units-format", u, "Done means has no labelled item"));
	if ("Scenarios" in u.raw && u.scenarios.length === 0) out.push(issue("units-format", u, "Scenarios has no labelled line"));
	for (const [list, line] of unlabelledItems(c, u)) {
		out.push({ ...issue("units-format", u, `${list} item without a [label]`), line });
	}
	if (u.statusText !== "- [ ] pending" && u.statusText !== "- [x] done") {
		out.push(issue("units-format", u, "status line must be '- [ ] pending' or '- [x] done'"));
	}
}

/** `units-format`: required fields, well-formed values, unique ids, existing Depends targets. */
export function validateUnits(c: Change): Result[] {
	const out: Result[] = [];
	const ids = new Set(c.units.map((u) => u.id));
	const seen = new Set<string>();
	for (const u of c.units) {
		if (seen.has(u.id)) out.push(issue("units-format", u, `duplicate unit id ${u.id}`));
		seen.add(u.id);
		checkFields(c, u, out);
		for (const d of u.depends) {
			if (!ids.has(d)) out.push(issue("units-format", u, `Depends names missing unit ${d}`));
		}
	}
	return out;
}

/** `done-maps-scenarios`: Done means labels and Scenarios labels match one to one. */
export function checkDoneMapsScenarios(c: Change): Result[] {
	const out: Result[] = [];
	for (const u of c.units) {
		const done = new Set(u.doneMeans.map((d) => d.label));
		const scen = new Set(u.scenarios.map((s) => s.label));
		for (const label of done) {
			if (!scen.has(label)) out.push(issue("done-maps-scenarios", u, `Done means [${label}] has no scenario`));
		}
		for (const label of scen) {
			if (!done.has(label)) out.push(issue("done-maps-scenarios", u, `Scenario [${label}] is not in Done means`));
		}
	}
	return out;
}
