// Shared setup for the `change_park` and `change_resume` tests: a build change with U1 done in the change
// worktree, U4 started there, U2 and U3 started in real worktree lanes (sharing the bare origin), a
// prerequisite change and an approved `new-dependency` result choosing A.

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { writeMarked } from "../../src/forge/markers.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import type { FakeUI } from "../hooks/fake-pi.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import type { ToolOut } from "./helpers.ts";
import { type Lane, openWorktreeLane } from "./lane-helpers.ts";
import { type UnitHarness, type UnitSpec, unitHarness } from "./unit-helpers.ts";

export const BRANCH = "livespec/per-ip-cap";
export const wip = (unit: string): string => `${BRANCH}--wip-${unit}`;

const red = (file: string) => `test -f ${file}\n`;
export const SCRIPTS = {
	// U1 turns red once the prerequisite's file lands on the branch.
	"u1.sh": "test -f src/u1.ts && test ! -f prereq.txt\n",
	"u2.sh": red("src/u2.ts"),
	"u3.sh": red("src/u3.ts"),
	"u4.sh": red("src/u4.ts"),
};
const UNITS: UnitSpec[] = ["U1", "U2", "U3", "U4"].map((id) => ({ id, verify: `sh ${id.toLowerCase()}.sh`, files: [`src/${id.toLowerCase()}.ts`] }));

export type ParkHarness = UnitHarness & {
	prereq: number;
	lanes: Record<"U2" | "U3", Lane>;
	park(): Promise<ToolOut>;
	resume(n?: number): Promise<ToolOut>;
	/** Rejects pushes of `<unit>`'s wip branch on origin until `allowPush`. */
	rejectPush(unit: string): void;
	allowPush(): void;
	/** Closes the prerequisite (`issue`, default `prereq`) with a merged pull request after landing `files` on origin/main. */
	mergePrereq(files?: Record<string, string>, issue?: number): Promise<void>;
};

/** Posts the `new-dependency` request and its approved result with `choice`, as the gate completion leaves them. */
export async function seedChoice(h: UnitHarness, choice: string): Promise<void> {
	const drafts = { unit: "U2", evidence: "e", a: { name: "token-store", proposal: "p", depends: [] }, b: { units: ["U5"], summary: "s" }, c: { summary: "s", follow_up: { name: "f", proposal: "p" } }, d: { action: "shape", reason: "r" } };
	await h.world.postComment(h.n, BOT_LOGIN, writeMarked("request", "gate-new-dependency.r1", { subject: "gate:new-dependency", kind: "gate", mode: "blocking", snapshot: { target: "new-dependency", failingWaivable: [], drafts } }));
	await h.seed("gate", "new-dependency.gate-new-dependency.r1", { request: "gate-new-dependency.r1", gate: "new-dependency", outcome: "approved", choice, notes: "", by: "alice", at: "t", adapter: "forge", head_sha: "h", waivers: [] });
}

function ok(out: ToolOut, what: string): void {
	expect(out.isError, `${what}: ${out.content.map((c) => c.text).join("\n")}`).toBeFalsy();
}

export type ParkHarnessOptions = {
	/** The seeded new-dependency choice; `null` seeds none. Default `A`. */
	choice?: string | null;
	/** With false, no prerequisite is seeded (`prereq` is 0) and Depends stays `—`, for a flow that adds it through `new_dependency`. */
	seedPrereq?: boolean;
	ui?: FakeUI;
	/** Committed files beside the unit scripts. */
	files?: Record<string, string>;
};

/** The fixture: U1 done, U4 started in the change worktree, U2 and U3 started in worktree lanes. */
export async function parkHarness(o: ParkHarnessOptions = {}): Promise<ParkHarness> {
	const h = await unitHarness({ units: UNITS, scripts: { ...SCRIPTS, ...o.files }, config: "integrationBranch: main\n", ...(o.ui ? { ui: o.ui } : {}) });
	const prereq = o.seedPrereq === false ? 0 : await h.world.seedIssue({ title: "token-store", labels: ["livespec", "livespec:phase/shape"] });
	if (prereq !== 0) await h.world.editBodyBehindBack(h.n, (await h.world.bodyOf(h.n)).replace("Depends: —", `Depends: #${prereq}`));
	await h.session.refresh();
	ok(await h.start("U1"), "start U1");
	await h.commit({ "src/u1.ts": "u1\n" }, "U1");
	ok(await h.finish("U1"), "finish U1");
	ok(await h.start("U4"), "start U4");
	const lanes = { U2: await openWorktreeLane(h, "U2"), U3: await openWorktreeLane(h, "U3") };
	ok(await h.start("U2"), "start U2");
	ok(await h.start("U3"), "start U3");
	if (o.choice !== null) await seedChoice(h, o.choice ?? "A");
	const hook = join(h.origin, "hooks", "pre-receive");
	const marker = join(h.origin, "reject-unit");
	writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do\n  if [ -f "${marker}" ] && [ "$ref" = "refs/heads/${BRANCH}--wip-$(cat "${marker}")" ]; then exit 1; fi\ndone\nexit 0\n`);
	chmodSync(hook, 0o755);
	return {
		...h,
		prereq,
		lanes,
		park: () => h.call("change_park", {}),
		resume: (n = h.n) => h.call("change_resume", { issue: n }),
		rejectPush: (unit) => writeFileSync(marker, unit),
		allowPush: () => writeFileSync(marker, "-none-"),
		mergePrereq: async (files = { "prereq.txt": "p\n" }, issue = prereq) => {
			h.git("switch", "-q", "main");
			for (const [path, text] of Object.entries(files)) await writeIn(h.root, path, text);
			commitAll(h.root, "token-store #41");
			h.git("push", "-q", "origin", "main");
			h.git("switch", "-q", BRANCH);
			const pr = await h.world.seedPullRequest({ head: "livespec/token-store", state: "closed", merged: true });
			await h.world.editBodyBehindBack(issue, `PR: #${pr}\n`);
			await h.world.forge.closeIssue(issue);
			await h.session.refresh();
		},
	};
}
