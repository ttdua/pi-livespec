// The one accessor through which hooks and tools reach the current session.

import type { Session } from "./session.ts";

let current: Session | undefined;

export function getSession(): Session | undefined {
	return current;
}

export function setSession(s: Session | undefined): void {
	current = s;
}
