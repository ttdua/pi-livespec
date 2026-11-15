// The `approver` doctor check (design D6): the configured adapter chain, where
// it comes from, and the adapter that would answer in the current session; an
// error when none is available. Reads only `DoctorDeps`.

import { type DoctorCheck, type DoctorResult, registerDoctorCheck } from "../commands/doctor.ts";
import { adapterChain } from "../config.ts";
import type { AdapterName } from "./approver.ts";

const ID = "approver";
const SUGGESTION = "set interaction.adapter in .pi/livespec/config.yaml (for example [in-session, forge]) or run in an interactive session";

/** Whether the forge can take requests: detected, writable and not blocked by the account. */
async function forgeAvailable(d: Parameters<DoctorCheck>[0]): Promise<boolean> {
	if (d.accountBlock !== undefined) return false;
	try {
		return !(await d.forge()).readOnly;
	} catch {
		return false;
	}
}

async function available(d: Parameters<DoctorCheck>[0], name: AdapterName): Promise<boolean> {
	return name === "in-session" ? d.hasUI : forgeAvailable(d);
}

export const checkApprover: DoctorCheck = async (d) => {
	const { chain, source } = adapterChain(d.config);
	let answering: AdapterName | undefined;
	for (const name of chain) {
		if (await available(d, name)) {
			answering = name;
			break;
		}
	}
	const head = `chain [${chain.join(", ")}], source ${source}`;
	const result: DoctorResult =
		answering === undefined
			? { id: ID, status: "error", message: `${head}; no adapter in the chain is available`, suggestion: SUGGESTION }
			: { id: ID, status: "ok", message: `${head}; ${answering} answers now` };
	return [result];
};

registerDoctorCheck(ID, checkApprover);
