// Registers every change tool of LS-04 on pi.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChangeNew } from "./change-new.ts";
import { registerChangeStart } from "./change-start.ts";
import { registerSkillNote } from "./skill-note.ts";
import { registerSpecGate } from "./spec-gate.ts";
import { registerSpecNext } from "./spec-next.ts";
import { registerSpecStatus } from "./spec-status.ts";
import { registerSpecWrite } from "./spec-write.ts";

export function registerChangeTools(pi: ExtensionAPI): void {
	registerSpecStatus(pi);
	registerSpecNext(pi);
	registerSkillNote(pi);
	registerSpecWrite(pi);
	registerChangeNew(pi);
	registerChangeStart(pi);
	registerSpecGate(pi);
}
