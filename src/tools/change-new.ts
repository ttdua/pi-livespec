// `change_new <name>`: creates only the change issue, in the first phase, with
// the fixed body template. It never creates a branch.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKebabName } from "../core/names.ts";
import { LABEL_LIVESPEC, phaseLabel } from "../forge/labels.ts";
import { afterForgeWrite, prepareWrite, type ToolResult, toolResult } from "./guard.ts";

export type ChangeNewParams = { name: string };
export type ChangeNewDetails = { number?: number };

const FIRST_PHASE = "shape";

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

export async function runChangeNew(p: ChangeNewParams): Promise<ToolResult<ChangeNewDetails>> {
	if (!isKebabName(p.name)) {
		return toolResult(`The change name must be kebab-case (a-z, 0-9, single hyphens): got "${p.name}".`, {}, true);
	}
	const w = await prepareWrite();
	if (!w.ok) return toolResult(w.message, {}, true);
	const open = await w.forge.searchIssues({ labels: [LABEL_LIVESPEC], state: "open" });
	const taken = open.find((i) => i.title === p.name);
	if (taken) return toolResult(`An open livespec change is already named ${p.name}: #${taken.number}. Nothing was created.`, {}, true);
	const issue = await w.forge.createIssue({ title: p.name, body: CHANGE_BODY_TEMPLATE, labels: [LABEL_LIVESPEC, phaseLabel(FIRST_PHASE)] });
	await afterForgeWrite(w.session, issue.number);
	return toolResult(`Created change #${issue.number} ${p.name} in ${FIRST_PHASE}. Run change_start #${issue.number} to create its branch.`, {
		number: issue.number,
	});
}

export function registerChangeNew(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "change_new",
		label: "New livespec change",
		description:
			"Create a livespec change issue named by a kebab-case name, in the shape phase, with the empty change template. It creates no branch; run change_start afterwards.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: {
			type: "object",
			properties: { name: { type: "string", description: "kebab-case change name, e.g. rate-limit" } },
			required: ["name"],
		} as never,
		execute: (_id, params) => runChangeNew(params as ChangeNewParams),
	});
}
