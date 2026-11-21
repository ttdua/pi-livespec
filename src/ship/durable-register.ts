// Registers the `durable-docs` check and the ship gate's confirmation section.

import { registerGatePayload } from "../engine/gates.ts";
import { SHIP_PHASE } from "./phase.ts";
import { registerCheck } from "../engine/registry.ts";
import { confirmationSection, durableDocsCheck } from "./durable-check.ts";

export function registerDurableDocs(): void {
	registerCheck("durable-docs", durableDocsCheck);
	registerGatePayload(SHIP_PHASE, (state) => confirmationSection(state));
}
