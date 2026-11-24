// drift-audit "Audit suggestions" end to end: the real session hooks over a temp repository with a local
// `origin/main` and a memory forge; the audit runs through `/livespec audit`'s reply.

import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import "../../src/audit/card.ts";
import { readAuditState } from "../../src/audit/state.ts";
import { auditReply } from "../../src/commands/subcommands.ts";
import { createGit } from "../../src/engine/git.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { cardText, cleanupHomes, harness, type Harness } from "../hooks/helpers.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupHomes();
});

const SPEC = `---
paths:
  - src/limit/**
---
# rate-limit

## Purpose

Limits requests.

## Requirements

### Requirement: Cap
The system SHALL cap requests.

#### Scenario: caps
- **WHEN** a client sends too many requests
- **THEN** they are rejected
`;

const NO_EVENTS = { on: () => () => undefined };

const git = (h: Harness, ...args: string[]): string => execFileSync("git", args, { cwd: h.root, encoding: "utf8" }).trim();

/** Points the local `origin/main` at HEAD, as a fetch of a pushed `main` would. */
const publish = (h: Harness): string => {
	const head = git(h, "rev-parse", "HEAD");
	git(h, "update-ref", "refs/remotes/origin/main", head);
	return head;
};

const resumeText = (h: Harness): string => {
	const entries = h.pi.entries.filter((e) => e.customType === "livespec-resume");
	return (entries.at(-1)?.data as { text: string } | undefined)?.text ?? "";
};

/** The `livespec:initiative-closed` listener the session hooks registered on pi's event bus. */
function initiativeClosedListener(h: Harness): (data: unknown) => unknown {
	const calls = h.pi.api.events.on.mock.calls as [string, (data: unknown) => unknown][];
	const found = calls.filter(([channel]) => channel === "livespec:initiative-closed");
	expect(found).toHaveLength(1);
	return (found[0] as [string, (data: unknown) => unknown])[1];
}

describe("audit suggestions", () => {
	test("a manual commit under a capability's paths is suggested at the next session start; the audit clears it", async () => {
		const h = await harness({ files: { "specs/rate-limit/spec.md": SPEC, "src/limit/cap.ts": "export const cap = 100;\n" } });
		publish(h);
		await h.start();
		expect(await cardText(h.pi, h.ctx)).not.toContain("Audit:");

		await writeIn(h.root, "src/limit/cap.ts", "export const cap = 200;\n");
		commitAll(h.root, "tweak limits");
		const bbb = publish(h);
		await h.start();
		const line = `Audit: commit ${bbb.slice(0, 7)} touches rate-limit — run /livespec audit`;
		expect(await cardText(h.pi, h.ctx)).toContain(line);
		expect(resumeText(h)).toContain(line);

		const out = await auditReply("", h.ctx as never, NO_EVENTS);
		expect(out.content).toContain("Drift report");
		expect(await cardText(h.pi, h.ctx)).not.toContain("Audit:");
		const state = await readAuditState(createGit(h.root));
		expect(state.pending).toEqual([]);
		expect(state.auditedCommit).toBe(bbb);
		expect(state.cursor).toBe(bbb);
	});

	test("Initiative closed: the card suggests the audit and the next audit posts on it", async () => {
		const h = await harness({ files: { "specs/rate-limit/spec.md": SPEC } });
		publish(h);
		await h.start();
		const initiative = await h.world.seedIssue({ title: "initiative" });
		await initiativeClosedListener(h)({ initiative, changes: [] });
		expect(await cardText(h.pi, h.ctx)).toContain(`Audit: initiative #${initiative} closed — run /livespec audit`);

		const out = await auditReply("", h.ctx as never, NO_EVENTS);
		expect(out.error).toBeUndefined();
		const comments = await h.world.forge.listComments(initiative);
		expect(comments.map((c) => c.body).join("\n")).toContain("Drift report");
		expect(await cardText(h.pi, h.ctx)).not.toContain("Audit:");
	});

	test("a refused audit leaves the state unchanged", async () => {
		const h = await harness({ files: { "specs/rate-limit/spec.md": SPEC } });
		publish(h);
		await h.start();
		await initiativeClosedListener(h)({ initiative: 30, changes: [] });
		const before = await readAuditState(createGit(h.root));
		git(h, "update-ref", "-d", "refs/remotes/origin/main");
		const out = await auditReply("", h.ctx as never, NO_EVENTS);
		expect(out.error).toBe("livespec audit refused");
		expect(await readAuditState(createGit(h.root))).toEqual(before);
		expect(await cardText(h.pi, h.ctx)).toContain("initiative #30 closed");
	});
});
