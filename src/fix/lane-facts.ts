// Lane facts (design D2): built by code from `git diff <merge-base>..HEAD` of a fix branch, for the pure `lane` rule.

import { capOf } from "../core/capabilities-diff.ts";
import { matchGlob } from "../core/glob.ts";
import { type Requirement, parseSpec } from "../core/spec.ts";
import type { Git } from "../engine/git.ts";
import { livingSpecs } from "../ship/context.ts";

export type SpecChange = {
	capability: string;
	added_requirements: string[];
	removed_requirements: string[];
	scenarios: { requirement: string; added: string[]; removed: string[] }[];
};

/** snake_case: written verbatim into the decision block's `facts`. */
export type LaneFacts = {
	files: string[];
	lines: number;
	spec_changes: SpecChange[];
	created_capabilities: string[];
	governance: string[];
	capability_code: { capability: string; files: string[]; spec_changed: boolean }[];
};

const SPECS = "specs/";
const CONSTRAINTS = "specs/constraints.md";
const DECISIONS = "specs/decisions/";
const SPEC_FILE = /^specs\/([^/]+)\/spec\.md$/;

const minus = (a: string[], b: string[]): string[] => a.filter((x) => !b.includes(x));

/** Requirements of a spec at `rev`; a missing file has none. */
async function requirementsAt(git: Git, rev: string, path: string, capability: string): Promise<Requirement[]> {
	const text = await git.showFile(rev, path);
	return text === undefined ? [] : parseSpec(text, capability).requirements;
}

/** Name-level differences of one spec between the merge base and HEAD; text edits never show. */
function specChange(capability: string, before: Requirement[], after: Requirement[]): SpecChange {
	const names = (rs: Requirement[]): string[] => rs.map((r) => r.name);
	const scenarios: SpecChange["scenarios"] = [];
	for (const req of after) {
		const old = before.find((r) => r.name === req.name);
		if (!old) continue;
		const now = req.scenarios.map((s) => s.name);
		const was = old.scenarios.map((s) => s.name);
		const added = minus(now, was);
		const removed = minus(was, now);
		if (added.length > 0 || removed.length > 0) scenarios.push({ requirement: req.name, added, removed });
	}
	return { capability, added_requirements: minus(names(after), names(before)), removed_requirements: minus(names(before), names(after)), scenarios };
}

async function specChanges(git: Git, mergeBase: string, files: string[]): Promise<SpecChange[]> {
	const changes: SpecChange[] = [];
	for (const path of files) {
		const capability = SPEC_FILE.exec(path)?.[1];
		if (capability === undefined || capability === "decisions") continue;
		const [before, after] = await Promise.all([requirementsAt(git, mergeBase, path, capability), requirementsAt(git, "HEAD", path, capability)]);
		changes.push(specChange(capability, before, after));
	}
	return changes;
}

/** Capabilities whose `specs/<cap>` directory exists at HEAD and not at the merge base. */
async function createdCapabilities(git: Git, mergeBase: string, files: string[]): Promise<string[]> {
	const caps = [...new Set(files.map(capOf).filter((c): c is string => c !== undefined))];
	const created: string[] = [];
	for (const cap of caps) {
		const dir = `${SPECS}${cap}`;
		if (!(await git.pathExistsAt(mergeBase, dir)) && (await git.pathExistsAt("HEAD", dir))) created.push(cap);
	}
	return created;
}

const isGovernance = (path: string): boolean => path === CONSTRAINTS || path.startsWith(DECISIONS);

/** Changed non-spec files under each living spec's `paths`, with whether that capability's spec file changed. */
async function capabilityCode(root: string, files: string[], touched: string[]): Promise<LaneFacts["capability_code"]> {
	const code = files.filter((f) => !f.startsWith(SPECS));
	return (await livingSpecs(root))
		.map((s) => ({
			capability: s.capability,
			files: code.filter((f) => s.paths.some((p) => matchGlob(p, f))),
			spec_changed: touched.includes(`${SPECS}${s.capability}/spec.md`),
		}))
		.filter((c) => c.files.length > 0);
}

/** Every path the diff touches: the numstat paths plus the source of each rename, so a file renamed away still counts. */
async function touchedPaths(git: Git, mergeBase: string, files: string[]): Promise<string[]> {
	const sources = (await git.diffNameStatus(mergeBase, "HEAD")).flatMap((e) => (e.oldPath === undefined ? [] : [e.oldPath]));
	return [...new Set([...files, ...sources])];
}

export async function laneFacts(git: Git, root: string, mergeBase: string): Promise<LaneFacts> {
	const entries = await git.diffNumstat(mergeBase, "HEAD");
	const files = entries.map((e) => e.path);
	const touched = await touchedPaths(git, mergeBase, files);
	return {
		files,
		lines: entries.reduce((n, e) => n + e.added + e.deleted, 0),
		spec_changes: await specChanges(git, mergeBase, touched),
		created_capabilities: await createdCapabilities(git, mergeBase, files),
		governance: touched.filter(isGovernance),
		capability_code: await capabilityCode(root, files, touched),
	};
}
