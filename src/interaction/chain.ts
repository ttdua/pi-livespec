// Runs an approval request through the configured adapter chain (design D6):
// adapters are tried in order, unavailable ones are skipped, and "answer later"
// moves an async copy of the request on to the next adapter.

import type { AdapterName, ApprovalRequest, Answered, Approver, Pending } from "./approver.ts";

export type ChainResult = Answered | Pending | { status: "deferred-all" } | { status: "refused"; message: string };

export interface ChainHooks {
	/** Called once, on the first "answer later"; the caller reclassifies the question as non-blocking. */
	onDeferred(): Promise<void>;
}

function refusal(chain: AdapterName[]): { status: "refused"; message: string } {
	const listed = chain.length > 0 ? chain.join(", ") : "none";
	return {
		status: "refused",
		message: `no approval adapter is available (interaction.adapter: [${listed}]); set interaction.adapter in .pi/livespec/config.yaml or run in an interactive session`,
	};
}

export async function runChain(
	chain: AdapterName[],
	adapters: Partial<Record<AdapterName, Approver>>,
	r: ApprovalRequest,
	hooks: ChainHooks,
): Promise<ChainResult> {
	let request = r;
	let deferred = false;
	for (const name of chain) {
		const adapter = adapters[name];
		if (!adapter?.available()) continue;
		const result = await adapter.request(request);
		if (result.status !== "deferred") return result;
		if (!deferred) {
			deferred = true;
			await hooks.onDeferred();
			request = { ...request, mode: "async", record: { ...request.record, mode: "async" } };
		}
	}
	return deferred ? { status: "deferred-all" } : refusal(chain);
}
