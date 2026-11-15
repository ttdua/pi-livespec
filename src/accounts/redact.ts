// Removes known tokens from text before it is shown or thrown.

const REDACTED = "***";

/** Replaces every occurrence of each non-empty token with `***`; longer tokens first, so one containing another is removed whole. */
export function redactTokens(text: string, tokens: string[]): string {
	const known = [...new Set(tokens.filter((t) => t !== ""))].sort((a, b) => b.length - a.length);
	return known.reduce((acc, token) => acc.split(token).join(REDACTED), text);
}
