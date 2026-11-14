// Marked comments: a first-line marker plus one fenced yaml block. Only the
// current account's marked comments count as state; everything else is ignored
// or reported as a warning.

import { parse, stringify } from "yaml";
import { ForgeError } from "./errors.ts";
import type { Comment, Forge } from "./types.ts";

export interface MarkedComment {
	/** Comment id as returned by the forge. */
	commentId: string;
	kind: string;
	id: string;
	author: string;
	data: unknown;
}

export interface MarkedReadResult {
	comments: MarkedComment[];
	warnings: string[];
}

const CORE_KINDS = [
	"receipt",
	"gate",
	"amendment",
	"counter",
	"decision",
	"question",
	"stale",
	"incomplete",
	"finding-summary",
	"stuck",
] as const;

const kinds = new Set<string>(CORE_KINDS);

/** Shared token rules: the writer validates against them and the parser only accepts them. */
const KIND_PATTERN = "[a-z0-9-]+";
const ID_PATTERN = "[A-Za-z0-9._-]+";
const KIND_TOKEN = new RegExp(`^${KIND_PATTERN}$`);
const ID_TOKEN = new RegExp(`^${ID_PATTERN}$`);

const MARKER_LINE = new RegExp(`^<!-- livespec:(${KIND_PATTERN}):(${ID_PATTERN}) -->$`);
const YAML_BLOCK = /^```yaml\n([\s\S]*?)^```\s*$/m;

/** Adds a kind to the registry so `writeMarked` accepts it. Throws on a kind that cannot be written as a marker token. */
export function registerKind(name: string): void {
	if (!KIND_TOKEN.test(name)) {
		throw new Error(`invalid marker kind "${name}": use only [a-z0-9-]`);
	}
	kinds.add(name);
}

/**
 * Returns the comment body: marker line, then one fenced yaml block with `data`.
 * Throws on unregistered kinds, ids that cannot be parsed back, and data that cannot be serialized.
 */
export function writeMarked(kind: string, id: string, data: unknown): string {
	if (!kinds.has(kind)) {
		throw new Error(`unregistered marker kind "${kind}"; call registerKind first`);
	}
	if (!ID_TOKEN.test(id)) {
		throw new Error(`invalid marker id "${id}": use only [A-Za-z0-9._-]`);
	}
	const yaml = stringify(data);
	if (typeof yaml !== "string") {
		throw new Error(`cannot serialize marker data for ${kind}:${id} to yaml`);
	}
	return `<!-- livespec:${kind}:${id} -->\n\`\`\`yaml\n${yaml}\`\`\``;
}

/** Parses a comment body. Returns null when the body has no valid marker or yaml block. */
export function parseMarked(body: string): { kind: string; id: string; data: unknown } | null {
	const newline = body.indexOf("\n");
	const firstLine = (newline === -1 ? body : body.slice(0, newline)).trimEnd();
	const marker = MARKER_LINE.exec(firstLine);
	if (!marker || newline === -1) return null;

	const block = YAML_BLOCK.exec(body.slice(newline + 1));
	if (!block) return null;

	try {
		return { kind: marker[1], id: marker[2], data: parse(block[1]) };
	} catch {
		return null;
	}
}

/**
 * Returns the marked comments of `issue` written by the current account.
 * Foreign marked comments become warnings; plain comments are ignored silently.
 */
export async function readMarkedComments(forge: Forge, issue: number): Promise<MarkedReadResult> {
	const [{ login }, comments] = await Promise.all([forge.whoami(), forge.listComments(issue)]);
	const result: MarkedReadResult = { comments: [], warnings: [] };

	for (const comment of comments) {
		const parsed = parseMarked(comment.body);
		if (!parsed) continue;

		if (comment.author !== login) {
			result.warnings.push(
				`ignored marked comment ${comment.id} (${parsed.kind}:${parsed.id}) written by ${comment.author}`,
			);
			continue;
		}
		result.comments.push({
			commentId: comment.id,
			kind: parsed.kind,
			id: parsed.id,
			author: comment.author,
			data: parsed.data,
		});
	}
	return result;
}

/** Refuses (throws ForgeError) unless `comment` carries a marker and was written by the current account. */
export async function assertOwnMarkedComment(forge: Forge, comment: Comment): Promise<void> {
	const { login } = await forge.whoami();
	if (parseMarked(comment.body) && comment.author === login) return;

	throw new ForgeError({
		code: "unsupported",
		operation: "updateComment",
		message: `refusing to edit comment ${comment.id}: not a marked comment written by ${login}`,
	});
}
