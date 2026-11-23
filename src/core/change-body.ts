// The body of a new change issue: the fixed template, and the template filled with an initiative,
// its Depends and a short Proposal.

import { replaceSection, setHeaderLine } from "./sections.ts";

export const CHANGE_BODY_TEMPLATE = [
	"Depends: —",
	"Capabilities: new [], modified []",
	"Product impact: —",
	"",
	"## Proposal",
	"",
	"## Design",
	"",
	"## Questions",
	"",
	"## Units",
	"",
	"## Durable docs",
	"",
].join("\n");

/** `Depends:` line value: `#a, #b`, or `—` without dependencies. */
export function dependsValue(depends: number[]): string {
	return depends.length === 0 ? "—" : depends.map((d) => `#${d}`).join(", ");
}

/** The template with an `Initiative` line (when given), the `Depends` line and the short Proposal. */
export function changeBody(o: { initiative?: number; depends: number[]; proposal: string }): string {
	const withDepends = setHeaderLine(CHANGE_BODY_TEMPLATE, "Depends", dependsValue(o.depends));
	const head = o.initiative === undefined ? withDepends : `Initiative: #${o.initiative}\n${withDepends}`;
	return replaceSection(head, "Proposal", o.proposal);
}
