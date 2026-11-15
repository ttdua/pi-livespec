// The message of a caught value, shared by every layer that reports an error.

export function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
