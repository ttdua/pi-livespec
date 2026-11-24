// Reads the living specs and the non-spec files of a `RepoView`, shared by the
// spec-side and doc-side detectors.

import { type Spec, parseSpec } from "../core/spec.ts";
import type { RepoView } from "./repo-view.ts";

const SPEC_FILE = /^specs\/([^/]+)\/spec\.md$/;
const DECISIONS_DIR = "decisions";

export type FileText = { path: string; text: string };

/** Every capability spec `specs/<capability>/spec.md`, skipping `specs/decisions/`. */
export async function livingSpecs(view: RepoView): Promise<{ file: string; spec: Spec }[]> {
	const specs: { file: string; spec: Spec }[] = [];
	for (const file of view.files) {
		const capability = SPEC_FILE.exec(file)?.[1];
		if (capability === undefined || capability === DECISIONS_DIR) continue;
		const text = await view.read(file);
		if (text !== undefined) specs.push({ file, spec: parseSpec(text, capability) });
	}
	return specs;
}

/** The text of every file whose path passes `keep`. */
export async function readFiles(view: RepoView, keep: (path: string) => boolean): Promise<FileText[]> {
	const out: FileText[] = [];
	for (const path of view.files.filter(keep)) {
		const text = await view.read(path);
		if (text !== undefined) out.push({ path, text });
	}
	return out;
}

export const outsideSpecs = (path: string): boolean => !path.startsWith("specs/");
