## Why

The LS-05 verify (`gates-and-decisions`) passed with warnings: the living specs and the archived design, plan and proposal no longer describe what was built (W3–W7, W11), the spec review left small gaps, and some contract members are dead code. Readers and later changes (LS-06+) build on these specs, so they must match the code. Issue #20 tracks this; three small behaviour fixes surfaced while closing the gaps.

## What Changes

**Specs describe existing behaviour** (no code change): a stuck answer records `outcome` and a dismissed one does not lift the cap; in-session prompts use `select` and `input` only; request kinds per subject (`amend:` → `gate`, `decide:` → `stuck`) and `overrides` in the answer; a waived failing check does not hold the next step and the change advances; named gates are human gates whose `options` follow `waive`; a forge approval read while the tree is dirty is superseded; in-session "answer later"; an approved identical-content amendment clears a stale unit.

**Stale units before the first lock**
- From: a unit made stale by a cascade before any plan lock stays stale after the first plan approval and forces an amendment.
- To: an approved, non-superseded plan gate newer than the `stale` comment clears its units.
- Reason: the first plan approval locks every unit as reviewed; nothing is left to amend.
- Impact: non-breaking; fewer spurious amendments.

**`/livespec class` takes effect once**

What the command is: every open question in the issue's `## Questions` section has a class, written in its line as `- [ ] Q2 (blocking): …` or `(non-blocking)`. A blocking question stops every gate and is the next step the agent must wait for; a non-blocking one lets work continue while it is open. When a question was sent to the forge, a human with write access can change its class without answering it by commenting `/livespec class Q2 non-blocking` (or `blocking`) on the issue. The plugin's poll reads that comment, rewrites the class token in Q2's line, and the pending question request then counts as `async` (or `blocking`). The human can also edit the line on the web directly.

The problem: the poll keeps no record that it already handled a `class` comment, so it handles the same comment again on every poll while Q2's request is pending. If someone later edits Q2 back to `(blocking)` on the web, the next poll silently rewrites it to `(non-blocking)`.

- From: every poll re-applies a pending question's `class` command, overwriting a later manual edit of the class.
- To: a `class` command is applied once and recorded; later polls skip it.
- Reason: a manual edit after the command must win.
- Impact: non-breaking; adds a marker kind `class`.

**`interaction.adapter` fallback**
- From: a project list whose names were all unknown masks user config and yields the default.
- To: an empty project list (after dropping unknown names) counts as unset; the chain falls back to user config, then the default.
- Reason: a typo in project config must not discard the user's chain (user decision).
- Impact: non-breaking.

**Dead contract members removed:** `Approver.poll`, `ApproverUI.confirm`, `GateSnapshot.digests`, `LockState.stalePhases`. Superseded reasons are no longer wrapped as untrusted twice. `Subject` becomes a template-literal type and request snapshots are narrowed by subject.

**Archived LS-05 artifacts corrected in place** (`design.md` D3, D5, D9, D13; `plan.md` Contracts; `proposal.md` modified requirements and known gaps), each with an "Errata (#20)" note.

## Capabilities

### New Capabilities

None.

### Modified Capabilities
- `approver-adapters`: "Approver contract" (no `poll`, kind per subject, `overrides`), "In-session adapter" (`select`/`input` only, answer later), "Forge command comments" (`class` applied once), "Adapter configuration" (fallback).
- `phase-gates`: "Gate tool" (named gates are human; `options`; cap refusal by reference), "Waivable checks" (a waived gate advances, except at `ship`), "Gate comment" (dirty tree supersedes).
- `flow-engine`: "Next step precedence" item 9 (waived checks) and item 5 (cap by reference).
- `questions-and-stuck`: "Requirement cascade" (pre-lock stale units need no amendment), "Iteration cap" and "Stuck reports" (`outcome`, dismissed answer).
- `unit-planning`: "Re-planning after the lock" (stale before the lock, identical amendment).

## Impact

- Code: `src/engine/locks.ts`, `src/engine/state-types.ts`, `src/interaction/approver.ts`, `src/interaction/forge.ts`, `src/interaction/in-session.ts`, `src/interaction/poll.ts`, `src/interaction/forge-match.ts`, `src/interaction/complete.ts`, `src/interaction/complete-validate.ts`, `src/interaction/requests.ts`, `src/tools/approver-for.ts`, `src/tools/spec-gate.ts`, `src/hooks/session.ts`, `src/config.ts`, and the `complete-*` readers of snapshots.
- Tests under `tests/engine`, `tests/interaction`, `tests/tools`, `tests/helpers/change-state.ts`.
- Docs: `docs/architecture.md` (approver contract), archived `2026-11-16-gates-and-decisions` artifacts.
- No new dependency; one new marker kind (`class`).
