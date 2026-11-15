// Small yaml-node helpers shared by the rule schemas.

import { type Node, type Pair, type YAMLMap, isMap, isScalar, isSeq } from "yaml";

export type Report = (n: Node, msg: string) => void;

export function keyName(pair: Pair): string | undefined {
	return isScalar(pair.key) ? String(pair.key.value) : undefined;
}

/** Reports every key of `map` outside `allowed`. */
export function checkAllowedKeys(map: YAMLMap, allowed: string[], path: string, report: Report): void {
	for (const pair of map.items) {
		const key = keyName(pair);
		if (key === undefined || !allowed.includes(key)) {
			report(pair.key as Node, `unknown key \`${key ?? "?"}\` in \`${path}\`; allowed: ${allowed.join(", ")}`);
		}
	}
}

/** Validates a map of name to list of non-empty strings; returns the string items with their nodes. */
export function stringListMap(node: Node | null, path: string, report: Report, owner: Node): { key: string; item: Node; value: string }[] {
	if (!isMap(node)) {
		report(node ?? owner, `\`${path}\` must be a map of lists`);
		return [];
	}
	const found: { key: string; item: Node; value: string }[] = [];
	for (const pair of node.items) {
		const key = keyName(pair) ?? "?";
		const list = pair.value as Node | null;
		if (!isSeq(list)) {
			report(list ?? (pair.key as Node), `\`${path}.${key}\` must be a list`);
			continue;
		}
		for (const item of list.items as Node[]) {
			if (isScalar(item) && typeof item.value === "string" && item.value !== "") found.push({ key, item, value: item.value });
			else report(item, `\`${path}.${key}\` entries must be non-empty strings`);
		}
	}
	return found;
}
