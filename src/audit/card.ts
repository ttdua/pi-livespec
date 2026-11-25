// The `audit` card section: one line naming each pending audit reason and the
// command that clears them. Reads only `i.audit` and is pure.

import { type CardSection, registerCardSection } from "../hooks/phase-card.ts";

export const auditSection: CardSection = (i) =>
	i.audit === undefined || i.audit.length === 0 ? undefined : `Audit: ${i.audit.join("; ")} — run /livespec audit`;

registerCardSection("audit", auditSection);
