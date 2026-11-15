// The `tags` rule: path globs and whole-word keywords per tag, plus agent extra tags.

import { type Node, isMap } from "yaml";
import { matchGlob, validateGlob } from "../../core/glob.ts";
import type { RuleResult, RuleSchema } from "../registry.ts";
import { checkAllowedKeys, keyName, stringListMap } from "./schema-util.ts";

export type TagsConfig = { mode: "rule"; paths: Record<string, string[]>; keywords: Record<string, string[]> };
export type TagsFacts = { title: string; covers: string[]; files: string[]; doneMeans: string[]; extraTags: string[] };

type ListMap = Record<string, string[]>;

function isRaw(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function listMap(v: unknown): ListMap {
	if (!isRaw(v)) return {};
	const out: ListMap = {};
	for (const [k, list] of Object.entries(v)) out[k] = Array.isArray(list) ? list.map(String) : [];
	return out;
}

/** Per-tag union that keeps first-seen order and drops duplicates. */
function unionListMap(base: ListMap, over: ListMap): ListMap {
	const out: ListMap = {};
	for (const [tag, list] of Object.entries(base)) out[tag] = [...new Set(list)];
	for (const [tag, list] of Object.entries(over)) out[tag] = [...new Set([...(out[tag] ?? []), ...list])];
	return out;
}

export const tagsSchema: RuleSchema = {
	validate(node, report) {
		if (!isMap(node)) return;
		checkAllowedKeys(node, ["mode", "paths", "keywords"], "decisions.tags", report);
		for (const pair of node.items) {
			const key = keyName(pair);
			if (key !== "paths" && key !== "keywords") continue;
			const items = stringListMap(pair.value as Node | null, `decisions.tags.${key}`, report, pair.key as Node);
			if (key !== "paths") continue;
			for (const { item, value } of items) {
				const error = validateGlob(value);
				if (error) report(item, `invalid glob \`${value}\`: ${error}`);
			}
		}
	},
	merge(base, over) {
		const b = isRaw(base) ? base : {};
		const o = isRaw(over) ? over : {};
		return {
			...b,
			...o,
			paths: unionListMap(listMap(b.paths), listMap(o.paths)),
			keywords: unionListMap(listMap(b.keywords), listMap(o.keywords)),
		};
	},
};

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordMatches(keyword: string, text: string): boolean {
	const source = escapeRegExp(keyword).replace(/ /g, "\\s+");
	return new RegExp(`(^|[^a-z0-9])${source}($|[^a-z0-9])`, "i").test(text);
}

/** The first fact that gives `tag`, as a short reason fragment, or undefined. */
function matchTag(tag: string, config: TagsConfig, f: TagsFacts, text: string): string | undefined {
	for (const glob of config.paths?.[tag] ?? []) {
		const file = f.files.find((p) => matchGlob(glob, p));
		if (file) return `${tag} (file ${file} matches ${glob})`;
	}
	const keyword = (config.keywords?.[tag] ?? []).find((k) => keywordMatches(k, text));
	return keyword === undefined ? undefined : `${tag} (keyword "${keyword}")`;
}

function tagsReason(matches: string[], agentAdditions: string[]): string {
	const rule = matches.length > 0 ? `rule: ${matches.join("; ")}` : "rule: no path or keyword matched";
	return agentAdditions.length > 0 ? `${rule}; agent added: ${agentAdditions.join(", ")}` : rule;
}

/** Tags in config order (paths first, then keyword-only tags), then the agent's extra tags. Throws on a non-kebab-case extra tag. */
export function tagsRule(facts: unknown, config: unknown): RuleResult {
	const f = facts as TagsFacts;
	const c = config as TagsConfig;
	const bad = f.extraTags.find((t) => !KEBAB.test(t));
	if (bad !== undefined) throw new Error(`extra tag \`${bad}\` must be kebab-case`);
	const text = [f.title, ...f.covers, ...f.doneMeans].join("\n");
	const order = [...new Set([...Object.keys(c.paths ?? {}), ...Object.keys(c.keywords ?? {})])];
	const reasons: string[] = [];
	const tags: string[] = [];
	for (const tag of order) {
		const why = matchTag(tag, c, f, text);
		if (why === undefined) continue;
		tags.push(tag);
		reasons.push(why);
	}
	const agentAdditions = [...new Set(f.extraTags)].filter((t) => !tags.includes(t));
	const outcome = [...tags, ...agentAdditions];
	return { outcome, reason: tagsReason(reasons, agentAdditions), data: { agentAdditions } };
}
