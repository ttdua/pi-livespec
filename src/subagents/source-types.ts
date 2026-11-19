// Shared shapes of packet building: sources, the build context, the target and the built packet.

import type { Unit } from "../core/change.ts";
import type { Git } from "../engine/git.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { Forge } from "../forge/types.ts";
import type { Finding, ReviewSubject, Role } from "./roles.ts";

/** One piece of context a child needs: `id` and `version` follow the spec's source id forms. */
export type PacketSource = { id: string; version: string; title: string; text: string; untrusted: boolean; required: boolean };

/** Everything a build reads. `session` only supplies the active content tree; `finding` feeds the `verifier`. */
export type PacketContext = {
	session: { activeTree?: string };
	state: ChangeState;
	pack: Pack;
	forge: Forge;
	git: Git;
	root: string;
	cwd: string;
	budgetTokens: number;
	finding?: Finding;
};

/** What a packet is for; `unit` is resolved from the change body. */
export type Target = { role: Role; unit?: Unit; subject?: ReviewSubject };

/** `pinned` stays inline whatever the budget; `inline` may spill; `file` is always a file (diffs). */
export type Placement = "pinned" | "inline" | "file";
export type Placed = { source: PacketSource; place: Placement };

export type PacketSourceRef = { id: string; version: string; required: boolean; spill?: string };

export type Packet = {
	text: string;
	hash: string;
	sources: PacketSourceRef[];
	skillPaths: string[];
	cwd: string;
	/** Ids of the human comments that existed at build time, so freshness can tell new ones. */
	seen: string[];
};

export type PacketResult = { ok: true; packet: Packet } | { ok: false; message: string };

export type SourceProvider = (ctx: PacketContext) => Promise<PacketSource[]>;
