## Design Summary

Issue #20, follow-up to LS-05 (#5). The verify of `gates-and-decisions` passed with warnings W3–W7 and W11 (artifact drift), and the spec and plan reviews left minor findings. This change makes the living specs and the archived LS-05 artifacts describe what was built, fills the small spec gaps, and removes dead code. Most items document existing behaviour; three change behaviour.

**Document existing behaviour (no code change):**
- A stuck answer records `outcome`; a dismissed stuck answer does not lift the iteration cap (`src/engine/iterations.ts` `liftsCap`).
- In-session yes/no prompts use `select`, never `confirm`, because `confirm` cannot tell "no" from cancel.
- Request kinds: an `amend:` request uses kind `gate`, a `decide:` request uses kind `stuck` (an option choice, wired by #24). The Approver contract states this mapping and adds `overrides` to the answer shape.
- A waived failing check does not hold the gate: the change moves to the successor (`next-step.ts`).
- A forge approval read while the working tree is dirty is superseded (the `dirtyTree` refusal re-run at validation).
- In-session "answer later" moves the request on to the next adapter as async and reclassifies the question as non-blocking.
- A named gate is always a human gate; its `options` are offered after `waive`, and the chosen id is recorded as the gate comment's `choice`. Choosing an option is not a waive.
- An amendment with identical content, once approved, clears the unit's stale state (any approved amendment after the `stale` comment does).
- Design and plan wording: D3 polling runs through the `registerLivespecTool` wrapper; D9 merge uses `--no-ff`; D13 fields are `lock.gates` and `iterations.stuckOpen`; proposal lists "Loop counters" as modified and cross-session or cross-machine double completion as a known gap.

**Behaviour changes:**
1. **Stale before lock.** A unit made stale by a cascade before any plan lock is cleared by the first approved plan gate. Today it stays stale after the lock and forces an amendment.
2. **`/livespec class` applied once.** A class command is applied only if it is newer than the question's latest class change; today every poll re-applies it while the request is pending, overwriting a later manual edit.
3. **`interaction.adapter` fallback.** A project list whose names were all unknown (dropped to empty) counts as unset, so the chain falls back to user config, then the default. Today it masks the user config and goes straight to the default. (User decision.)

**Code cleanup (no behaviour change):** remove `GateSnapshot.digests`, `LockState.stalePhases`, `ApproverUI.confirm` and the forge adapter's unused `poll` (and `Approver.poll` from the contract); stop wrapping the superseded reason in `untrusted` twice; type `Subject` as a template literal and give request snapshots a `kind` discriminant.

Existing requirements involved:
- `questions-and-stuck` / "Iteration cap", "Stuck reports": add `outcome` and the dismissed case.
- `approver-adapters` / "Approver contract" (kinds, `overrides`, `poll` removed), "In-session adapter" (`select` only, answer later), "Forge command comments" (class applied once), "Adapter configuration" (fallback), "Durable answers" / validation (dirty tree superseded).
- `flow-engine` / "Next step precedence" item 9; `phase-gates` / "Waivable checks" scenario "Waive at the gate", "Gate tool" (named gate semantics).
- `unit-planning` / "Re-planning after the lock" (stale before lock, identical amendment).

Non-goals: W1/W2/W8/W9/W10 (handled by #17–#19, #24); new gate kinds; changing what a waiver means.

Anti-goals: rewriting archived artifacts so their history is lost; a spec change that silently alters behaviour beyond the three listed.

## Alternatives Considered

### Alternative A: Direct edits, no change directory
- **Approach**: edit living specs and archived artifacts in place; clean code with TDD.
- **Pros**: fastest.
- **Cons**: new scenarios and three behaviour changes skip delta review, validate and verify.
- **Why not chosen**: the behaviour changes and new scenarios need the spec-change path.

### Alternative B: Split docs and code into two changes
- **Approach**: one docs-only PR, one code cleanup change.
- **Pros**: smaller reviews.
- **Cons**: the spec gaps and the behaviour changes cross both halves; two rounds of verify.
- **Why not chosen**: the code part is small and shares specs with the docs part.

### Alternative C: One OpenSpec change (chosen)
- **Approach**: one change with delta specs for the touched capabilities, archived artifacts corrected in place with an errata line, code cleanup and the three behaviour changes under TDD.
- **Pros**: every new scenario gets a test; one verify.
- **Cons**: a larger packet to review.
- **Why not chosen**: n/a — chosen.

## Agreed Approach

Alternative C, chosen by the user in chat (`/opsx-ff`). Working on feature branch `ls-05-20`, as earlier LS-05 follow-ups did.

## Key Decisions

- Archived LS-05 artifacts (`design.md`, `plan.md`, `proposal.md` of `2026-11-16-gates-and-decisions`) are corrected in place, each with a closing "Errata (#20)" line listing what changed. (Agent's call.)
- `interaction.adapter`: an all-unknown project list falls back to user config, then the default. (User decision.)
- A `/livespec class` command takes effect once; a later manual edit of the class wins. (Agent's call, presented to the user.)
- First plan approval clears pre-lock stale units; an approved identical-content amendment clears a stale unit. (Agent's call, presented to the user.)
- Unused contract members are removed, not wired. (Agent's call.)

## Open Questions

None.
