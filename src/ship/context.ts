// The git facts of the ship phase (design D9): one fetch of the integration branch and one change diff per HEAD,
// memoized on the session, plus the durable-docs facts recomputed from the current issue body on every call.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { messageOf } from "../core/messages.ts";
import { parseSpec } from "../core/spec.ts";
import { integrationBranch } from "../engine/git.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { Session } from "../hooks/session.ts";
import { type ChangeDiff, changeDiff } from "./diff.ts";
import { SHIP_PHASE } from "./phase.ts";
import { type DurableFacts, durableDocsRule, durableFacts } from "./durable-docs.ts";

export type ShipContext = { diff: ChangeDiff; integrationTip: string; facts: DurableFacts };

type Fetched = { diff: ChangeDiff; integrationTip: string };

const memo = new WeakMap<Session, { key: string; value: Fetched }>();
const SPECS_DIR = "specs";

async function fetchOnce(session: Session, state: Pick<ChangeState, "git" | "change">): Promise<Fetched | { refused: string }> {
	const project = session.config.project;
	if (project === null) return { refused: "livespec is not set up in this project." };
	const integration = await integrationBranch(project, session.git);
	if (integration === undefined) return { refused: "no integration branch: set integrationBranch in the livespec config or set origin/HEAD." };
	const key = `${state.git.head}\0${state.change.header.base ?? ""}\0${integration}`;
	const cached = memo.get(session);
	if (cached?.key === key) return cached.value;
	const diff = await changeDiff(session.git, state.change.header.base, integration);
	if ("refused" in diff) return diff;
	let integrationTip: string;
	try {
		integrationTip = await session.git.revParse(`origin/${integration}`);
	} catch (error) {
		return { refused: `cannot read origin/${integration}: ${messageOf(error)}` };
	}
	const value = { diff, integrationTip };
	memo.set(session, { key, value });
	return value;
}

/** Each living spec's capability and `paths`; an unreadable or unparseable spec is left out. */
async function livingSpecs(root: string): Promise<DurableFacts["specs"]> {
	const entries = await readdir(join(root, SPECS_DIR), { withFileTypes: true }).catch(() => []);
	const specs: DurableFacts["specs"] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === "decisions") continue;
		try {
			const spec = parseSpec(await readFile(join(root, SPECS_DIR, entry.name, "spec.md"), "utf8"), entry.name);
			specs.push({ capability: entry.name, paths: spec.paths });
		} catch {
			// no spec.md or not parseable: the spec-format check reports it
		}
	}
	return specs;
}

export async function shipContext(session: Session, state: Pick<ChangeState, "git" | "change">): Promise<ShipContext | { refused: string }> {
	const fetched = await fetchOnce(session, state);
	if ("refused" in fetched) return fetched;
	const facts = durableFacts(fetched.diff, state.change, await livingSpecs(session.cwd));
	return { ...fetched, facts };
}

/** The ship context in the `ship` phase only (undefined elsewhere); a refusal or a git failure is carried, so the check fails closed. */
export async function shipFor(session: Session, state: Pick<ChangeState, "phase" | "git" | "change">): Promise<ShipContext | { refused: string } | undefined> {
	if (state.phase.kind !== "ok" || state.phase.id !== SHIP_PHASE) return undefined;
	try {
		return await shipContext(session, state);
	} catch (error) {
		return { refused: messageOf(error) };
	}
}

/** The `ChangeState.ship` fields this context gives. */
export function shipFacts(ship: ShipContext | { refused: string }): NonNullable<ChangeState["ship"]> {
	if ("refused" in ship) return {};
	return { docsRowsNeeded: durableDocsRule(ship.facts).needsRows, durableFacts: ship.facts };
}
