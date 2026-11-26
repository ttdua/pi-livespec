// Makes agent text safe to draw in a terminal: no escape sequences, control or bidi characters.

import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { neutralise } from "../briefing.ts";

// C0 (except tab and newline), DEL and C1.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// LRE, RLE, PDF, LRO, RLO and the isolates LRI, RLI, FSI, PDI.
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;

/** `neutralise`, then terminal sequences removed whole, then control and bidi characters; tabs become two spaces. */
export function sanitize(text: string): string {
	return stripTerminalSequences(neutralise(text)).replace(CONTROL, "").replace(BIDI, "").replaceAll("\t", "  ");
}
