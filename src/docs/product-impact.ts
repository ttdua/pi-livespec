// `product-impact` check: the change header's `Product impact` line is `updated` or `none — <reason>`.

import type { Change } from "../core/change.ts";
import type { Result } from "../core/result.ts";

const NONE = /^none — (.*)$/;

function error(message: string): Result {
	return { code: "product-impact", severity: "error", section: "Product impact", message };
}

/** Errors for a missing, empty or malformed line, and for `none` next to a new capability. */
export function productImpactResults(change: Change): Result[] {
	const value = change.header.productImpact?.trim();
	if (value === undefined || value === "" || value === "—") {
		return [error("Product impact is missing: write `updated` or `none — <reason>`")];
	}
	if (value === "updated") return [];
	const reason = NONE.exec(value)?.[1]?.trim();
	if (reason === undefined || reason === "") return [error(`Product impact "${value}" must be \`updated\` or \`none — <reason>\` with a reason`)];
	const created = change.header.capabilities?.new ?? [];
	if (created.length > 0) return [error(`Product impact is \`none\` but the change adds new capabilities: ${created.join(", ")}`)];
	return [];
}
