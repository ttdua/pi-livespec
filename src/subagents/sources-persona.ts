// The persona provider: a `change` or `persona:<name>` reviewer reads its persona file from the active content tree.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { placed, sha256, type Provider } from "./source-kit.ts";

/** The persona a reviewer subject runs as: `change` is `code-reviewer`. */
export function personaOf(subject: string | undefined): string | undefined {
	if (subject === "change") return "code-reviewer";
	return subject?.startsWith("persona:") === true ? subject.slice("persona:".length) : undefined;
}

/** `file:agents/<name>.md`, required and pinned; a missing file refuses the packet. */
export const personaFile: Provider = {
	name: "persona-file",
	async run({ ctx, target }) {
		const name = personaOf(target.subject);
		if (name === undefined) return [];
		const rel = `agents/${name}.md`;
		const missing = new Error(`persona file ${rel} is missing from the content tree`);
		if (ctx.session.activeTree === undefined) throw missing;
		let text: string;
		try {
			text = await readFile(join(ctx.session.activeTree, rel), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missing;
			throw error;
		}
		return [placed({ id: `file:${rel}`, version: sha256(text), title: `Persona: ${name}`, text, untrusted: false }, "pinned")];
	},
};
