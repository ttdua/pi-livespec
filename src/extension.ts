import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatMigrate, runMigrate } from "./commands/migrate.ts";
import { runValidateCommand } from "./commands/validate.ts";
import { registerSpecValidate } from "./tools/spec-validate.ts";
import { readVersion } from "./version.ts";

const USAGE = "Usage: /livespec [validate | migrate-openspec]";

export default function extension(pi: ExtensionAPI): void {
	const say = (customType: string, content: string) => pi.sendMessage({ customType, content, display: true });

	const validate = async (ctx: ExtensionCommandContext) => {
		const { message, exitCode } = await runValidateCommand(ctx.cwd);
		say("livespec-validate", message);
		if (exitCode === 1) ctx.ui.notify("livespec validate found errors", "error");
	};

	const migrate = async (ctx: ExtensionCommandContext) => {
		try {
			const result = await runMigrate(ctx.cwd);
			say("livespec-migrate", formatMigrate(result));
			if (result.conflicts.length > 0) ctx.ui.notify("livespec migrate-openspec refused: targets exist", "error");
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			say("livespec-migrate", `migrate-openspec failed: ${reason}`);
			ctx.ui.notify("livespec migrate-openspec failed", "error");
		}
	};

	pi.registerCommand("livespec", {
		description: "Show the pi-livespec version; subcommands: validate, migrate-openspec",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] ?? "";
			if (sub === "") return say("livespec-version", `pi-livespec ${readVersion()}`);
			if (sub === "validate") return validate(ctx);
			if (sub === "migrate-openspec") return migrate(ctx);
			return say("livespec-usage", USAGE);
		},
	});
	registerSpecValidate(pi);
}
