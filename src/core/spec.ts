import { parseFrontmatter } from "./frontmatter.ts";
import { type Line, joinLines, splitLines } from "./lines.ts";

export type Scenario = { name: string; line: number; when: string[]; then: string[] };
export type Requirement = { name: string; text: string; line: number; scenarios: Scenario[] };
export type Spec = {
	capability: string;
	paths: string[];
	purpose: string;
	requirements: Requirement[];
	lines: Line[];
};

const H2 = /^## (.*)$/;
const REQUIREMENT = /^### Requirement:\s*(.*?)\s*$/;
const SCENARIO = /^#### Scenario:\s*(.*?)\s*$/;
const WHEN = /^\s*[-*]\s+\*\*WHEN\*\*\s*(.*?)\s*$/;
const THEN = /^\s*[-*]\s+\*\*THEN\*\*\s*(.*?)\s*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

type Fence = { char: string; len: number };

/** Opens a fenced code block; a backtick fence's info string may not contain backticks. */
function openFence(t: string): Fence | undefined {
	const m = FENCE_OPEN.exec(t);
	if (!m) return undefined;
	const marker = m[1] ?? "";
	if (marker[0] === "`" && (m[2] ?? "").includes("`")) return undefined;
	return { char: marker[0] ?? "", len: marker.length };
}

/** A closing fence uses the same character, at least the opening length, and nothing else. */
function closesFence(t: string, f: Fence): boolean {
	const m = FENCE_CLOSE.exec(t);
	return m !== null && m[1]?.[0] === f.char && (m[1]?.length ?? 0) >= f.len;
}

/** Parses a living spec. `lines` keeps every original line, so serializing is byte-exact. */
export function parseSpec(text: string, capability: string): Spec {
	const fm = parseFrontmatter(text);
	const paths = Array.isArray(fm.data.paths) ? fm.data.paths.filter((p): p is string => typeof p === "string") : [];
	const lines = splitLines(text);
	const purpose: string[] = [];
	const requirements: Requirement[] = [];
	const bodies: string[][] = [];
	let section = "";
	let req: Requirement | undefined;
	let scenario: Scenario | undefined;
	let fence: Fence | undefined;
	for (let i = fm.raw.length; i < lines.length; i++) {
		const t = lines[i]?.text ?? "";
		// Fence lines (open, body, close) are never structure; they stay as text in their section.
		const wasFenced = fence !== undefined;
		if (fence) {
			if (closesFence(t, fence)) fence = undefined;
		} else {
			fence = openFence(t);
		}
		if (wasFenced || fence) {
			if (section === "Purpose") purpose.push(t);
			else if (section === "Requirements" && req && !scenario) bodies[bodies.length - 1]?.push(t);
			continue;
		}
		const h2 = H2.exec(t);
		if (h2) {
			section = h2[1]?.trim() ?? "";
			req = undefined;
			scenario = undefined;
			continue;
		}
		if (section === "Purpose") purpose.push(t);
		if (section !== "Requirements") continue;
		const r = REQUIREMENT.exec(t);
		if (r) {
			req = { name: r[1] ?? "", text: "", line: i + 1, scenarios: [] };
			requirements.push(req);
			bodies.push([]);
			scenario = undefined;
			continue;
		}
		if (!req) continue;
		const s = SCENARIO.exec(t);
		if (s) {
			scenario = { name: s[1] ?? "", line: i + 1, when: [], then: [] };
			req.scenarios.push(scenario);
			continue;
		}
		if (scenario) {
			const w = WHEN.exec(t);
			const th = THEN.exec(t);
			if (w) scenario.when.push(w[1] ?? "");
			else if (th) scenario.then.push(th[1] ?? "");
		} else {
			bodies[bodies.length - 1]?.push(t);
		}
	}
	requirements.forEach((rq, i) => {
		rq.text = (bodies[i] ?? []).join("\n").trim();
	});
	return { capability, paths, purpose: purpose.join("\n").trim(), requirements, lines };
}

export function serializeSpec(s: Spec): string {
	return joinLines(s.lines);
}
