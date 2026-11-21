// Registers the `durable-docs` check and the ship gate's confirmation section.

import { registerGatePayload } from "../engine/gates.ts";
import { registerCheck } from "../engine/registry.ts";
import { confirmationSection, durableDocsCheck } from "./durable-check.ts";

export function registerDurableDocs(): void {
	registerCheck("durable-docs", durableDocsCheck);
	registerGatePayload("ship", (state) => confirmationSection(state));
}
