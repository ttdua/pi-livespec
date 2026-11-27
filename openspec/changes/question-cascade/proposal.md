## Why

After a question is answered, livespec asks the human whether the answer changes a requirement and lists every requirement of the declared capabilities. The human lacks the coverage context to answer, the consequence (stale units, a move back to define) is hidden, and in practice everyone picks "no", so the cascade never runs. A real requirement change is already visible in git as a spec edit, and spec edits made outside `spec_question` never cascade today. Deriving the cascade from the spec diff fixes both (issue #63).

## What Changes

**Question answers**
- From: after picking or typing an answer, the human says whether it changes a requirement (dialog Review tab, `select` fallback, `/livespec answer … --changes …`); the answer drives the cascade.
- To: answering is one step (candidate, own text, or answer later). No requirement list anywhere. `/livespec answer Q<n> <text> --changes …` is refused with a message that the flag was removed. The `question` comment drops `changes_requirement`.
- Reason: the human cannot answer the requirement step reliably, and the data is already in git.
- Impact: breaking for the forge command grammar (the `--changes` flag); old answer comments and records stay readable.

**Requirement cascade**
- From: triggered by an answer naming a changed requirement.
- To: triggered by the spec diff. The approved plan gate records a content digest for every requirement in scope (declared capabilities and capabilities named in a unit's `Covers`), and every cascade `stale` record carries the digests it acknowledged. A requirement whose digest at HEAD differs from its latest acknowledged digest (whitespace and line moves ignored) is a changed requirement, handled once per content: a `stale` record names it and the units whose `Covers` names it, the done ones are unticked, and the change moves back to `define` when it is past it, even when no unit is affected. Requirement edits brought in from the integration branch, by `change_sync`, a hand merge or the forge's update button, do not count. Rebases and force-pushes do not affect the baseline. A change locked before this release computes its digests from the lock commit, and fails closed to `define` only when that commit is gone. `unit_finish` refuses outside `build`.
- Reason: catch every requirement edit after the plan, including amendments, pull request feedback and hand edits.
- Impact: stale semantics and clearing, `change_iterations` counting and idempotent completion are unchanged.

**Plan gate record**
- The plan gate request records `requirements: { <id>: <digest> }` at the HEAD it is bound to, and the approved plan `gate` comment copies it.

**Triggers**
- The detector runs at `session_start`, `/livespec next`, and before `spec_gate` and `unit_finish`.

**Shared detector**
- The requirement content comparison used by `change_sync` becomes one shared function that reads requirements from two `(revision, path)` sources; `change_sync` and the spec-diff cascade both call it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `questions-and-stuck`: "Question answers" drops `changes_requirement`; "Requirement cascade" is removed and replaced by "Requirement baseline", "Integration-branch exclusion", "Spec-diff requirement cascade", "Locks without requirement digests" and "Cascade triggers". The capability's Purpose line ("the cascade when an answer changes a requirement") is updated at sync.
- `approver-adapters`: "Approver contract" drops `changesRequirement`; "In-session adapter", "In-session dialog" and "Dialog questions" drop the requirement step; "Dialog exits without Review" drops the typed-requirement editor; "Forge command comments" drops `--changes` and refuses it.
- `phase-gates`: "Gate outcomes" rewords the scenario that sent the change back through an answer.
- `unit-evidence`: "Unit finish tool" refuses outside a `per: unit` phase.
- `unit-planning`: "Re-planning after the lock" rewords the scenario that relied on an answer's cascade before the first lock, and states that every approved plan gate records the requirement digests and is the new cascade baseline.

## Impact

- Code: `src/interaction/` (`in-session.ts`, `dialog/*`, `commands.ts`, `forge-match.ts`, `forge-text.ts`, `complete-question.ts`, `complete.ts`, `approver.ts`), `src/tools/spec-question.ts`, `src/initiatives/sync.ts` (calls the shared detector), a new spec-cascade module, the triggers in `src/hooks/session.ts`, `src/commands/next.ts`, `src/tools/spec-gate.ts`, `src/tools/unit-finish.ts`, and `src/engine/git.ts` (a commit-existence check for the pre-release migration path), `src/tools/spec-gate.ts` and `src/interaction/complete-gate.ts` (digest map on plan gate requests and comments), `src/evidence/refusals.ts` (phase rule for `unit_finish`).
- `change-initiatives` "Sync with the integration branch": behaviour unchanged, so no delta spec; only its implementation calls the shared detector.
- Docs: `README.md`, `README.vi.md`, `docs/architecture.md` (forge command grammar and the cascade paragraph), `CHANGELOG.md`.
- Follow-up: a durable spec baseline in the LS-12 ledger is proposed on #59 and is out of scope here.
