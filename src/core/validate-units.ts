import type { Change, Unit } from "./change.ts";
import type { Result } from "./result.ts";

const COVERS = /^[a-z0-9][a-z0-9-]*\/Requirement: \S/;
const ITEM = /^- \[[^\]\s][^\]]*\]\s+\S/;
const FIELD_NAME = /^(Covers|Difficulty|Tags|Files|Done means|Scenarios|Depends|Verify|Kind):/;
const SINGLE_COMMAND = /^`[^`]+`$/;
const DIFFICULTIES = ["low", "medium", "high"];
const REQUIRED = ["Covers", "Difficulty", "Tags", "Files", "Done means", "Scenarios", "Verify"];

type ListName = "Done means" | "Scenarios";
const ITEM_HINT: Record<ListName, string> = {
	"Done means": 'Done means item must be "- [label] text"',
	Scenarios: 'Scenarios item must be "- [label] test reference"',
};

function issue(code: string, u: Unit, message: string): Result {
	return { code, severity: "error", section: u.id, line: u.startLine + 1, message: `${u.id}: ${message}` };
}

/** Every non-empty line of a Done means / Scenarios list that is not a `- [label] text` item, one entry per line. */
function badListLines(c: Change, u: Unit): { line: number; message: string }[] {
	const bad: { line: number; message: string }[] = [];
	let list: ListName | undefined;
	for (let i = u.startLine + 1; i <= u.endLine; i++) {
		if (i === u.statusLine) continue;
		const text = c.lines[i]?.text ?? "";
		const field = FIELD_NAME.exec(text);
		if (field) {
			list = field[1] === "Done means" || field[1] === "Scenarios" ? field[1] : undefined;
			continue;
		}
		if (list === undefined || text.trim() === "" || ITEM.test(text)) continue;
		bad.push({ line: i + 1, message: `${ITEM_HINT[list]}: ${text.trim()}` });
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
	for (const b of badListLines(c, u)) {
		out.push({ ...issue("units-format", u, b.message), line: b.line });
	}
	if (u.statusText !== "- [ ] pending" && u.statusText !== "- [x] done") {
		out.push(issue("units-format", u, "status line must be '- [ ] pending' or '- [x] done'"));
	}
}

/** `units-format`: required fields, well-formed values, unique ids, existing Depends targets (Depends itself is optional). */
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

/**
 * `done-maps-scenarios`: label coverage in both directions. Every Done means label needs at least one
 * Scenario with that label, and every Scenario label must appear in Done means. Several scenarios may share a label.
 */
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
