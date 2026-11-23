import { parseChange, type Change } from "../../src/core/change.ts";

/** A change body with `capabilities` modified capabilities and `units` unit blocks. */
export function sizedChange(capabilities: number, units: number): Change {
	const caps = Array.from({ length: capabilities }, (_, i) => `cap-${i + 1}`).join(", ");
	const blocks = Array.from({ length: units }, (_, i) => `### U${i + 1} — Unit ${i + 1}\nCovers: cap-1/Requirement: R\nDifficulty: low\nTags: []\nFiles: src/u${i + 1}.ts\nDepends: —\n- [ ] pending\n`);
	return parseChange(`Base: abc\nCapabilities: new [], modified [${caps}]\n\n## Units\n${blocks.join("\n")}`);
}
