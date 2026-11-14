import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runValidateCommand } from "../commands/validate.ts";

export function registerSpecValidate(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "spec_validate",
		label: "Validate specs",
		description: "Run every livespec check over the repository's specs/ folder and list the results.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: { type: "object", properties: {} } as never,
		execute: async (_id, _params, _signal, _onUpdate, ctx) => {
			const { message, results, exitCode } = await runValidateCommand(ctx.cwd);
			return { content: [{ type: "text", text: message }], details: { results }, isError: exitCode === 1 };
		},
	});
}
