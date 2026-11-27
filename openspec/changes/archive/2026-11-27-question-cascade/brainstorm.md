## Design Summary

Source: issue #63. Answering a question stops asking the human which requirement the answer changes. The requirement cascade is derived from the spec diff instead: once a plan lock exists, a requirement whose content at HEAD differs from the content the plan gate approved (recorded as a digest) makes the change go back to `define`, and every unit whose `Covers` names it is marked stale, the done ones unticked.

Why: the human lacks the context to pick the right requirement (coverage, done units), the consequence of picking one is hidden, users in practice always answer "no", so the cascade never runs. The real signal already exists in git: a requirement that really changes is edited in `specs/<capability>/spec.md`. Deriving from the diff also covers spec edits made outside `spec_question` (amendments, pull request feedback, agent or hand edits), which today never cascade.

Goals:
- Answering a question is one step: pick a candidate, type an answer, or answer later. No requirement list in the dialog, the `select` fallback or the forge command.
- `/livespec answer Q<n> <text> --changes …` is refused with a message that the flag was removed.
- One detector computes and compares requirement digests, shared by `change_sync` (old base vs new base) and the new spec-diff cascade (approved digests vs HEAD), instead of two copies.
- The detector runs wherever the phase is resolved (`session_start`, `/livespec next`) and before `spec_gate` and `unit_finish`, so a spec edit cannot slip past a gate or a unit completion.
- Whitespace-only or line-moved edits of a requirement do not count as a change.
- A rerun after a partial cascade completes it without double counting.

Non-goals:
- Detecting an answer that changes behaviour without a spec edit. That stays an agent-discipline gap, already covered by the `behavior-change` and `review-clean` checks at review; the current design does not catch it either.
- Changing stale semantics or how stale is cleared (amendment approval, plan re-approval), `change_iterations` counting or the iteration cap.
- Cascading before the first plan lock: before a lock, the spec is still being shaped in `define`/`plan` and the define gate already covers it.

Anti-goals:
- The cascade re-firing on every poll for the same edit, re-staling units that were already amended.
- `change_sync` merging a sibling's spec edits being treated as this change's own edit (moving it to `define` and counting an iteration).

Specified requirements this change alters (stated explicitly):
- `questions-and-stuck` "Question answers": the `question` comment drops `changes_requirement`; the "except the status lines that a cascade unticks" clause goes away because answering no longer unticks anything.
- `questions-and-stuck` "Requirement cascade": the trigger changes from "an answer changes a requirement" to "HEAD changes a requirement's content relative to the digests the plan gate approved"; the `stale` record names the changed requirements instead of a question. Stale clearing, `change_iterations` derived from own `stale` comments, and idempotent completion are kept.
- `approver-adapters` "Approver contract": `answered` no longer carries `changesRequirement`.
- `approver-adapters` "In-session adapter" (the in-session dialog and its `select` fallback): no "does the answer change a requirement" step; the "Question candidate picked in session" scenario drops it.
- `approver-adapters` "Forge command comments": the `answer` grammar drops `--changes`; the "Answer that changes a requirement" scenario is replaced by a refusal scenario.
- `unit-planning` "Re-planning after the lock": the "Stale before the first lock" scenario is triggered by an answer's cascade today; since the cascade now needs a lock, that scenario is reworded or removed.
- `change-initiatives` "Sync with the integration branch": behaviour unchanged; it only names the shared detector.

## Alternatives Considered

### Alternative A: Git diff against the lock commit
- **Approach**: the baseline is the `head_sha` of the latest approved plan gate. The shared detector reads `specs/<capability>/spec.md` at that commit and at HEAD and compares requirement content. `change_sync` calls the same detector with its old and new base.
- **Pros**: matches the issue wording ("relative to the lock commit"); no new data in gate comments; works for changes locked before this release; one detector for both callers; a re-approved plan gate moves the baseline naturally.
- **Cons**: needs the lock commit's objects to exist locally. A rebase on the same machine keeps them (reflog), but a force-push followed by a fresh clone, or a rebase followed by `git gc`, loses them; the design fails closed in that case (see Key Decisions).

### Alternative B: Requirement digests recorded in the plan gate comment
- **Approach**: the plan gate stores `requirements: {name: digest}` next to `locked`; the detector compares HEAD against that map.
- **Pros**: independent of git history.
- **Cons as first assessed**: changes the gate comment format; changes locked before this release have no record; seemed not to fit `change_sync`'s two-revision comparison.
- **Why chosen after review**: the first objections fall away. Changes locked before this release get a migration path (digests computed from the lock commit while it exists), and the shared detector stays: git still computes digests at any revision, for `change_sync` as for this cascade. With many changes and pull requests in flight, branches get rebased or force-pushed, and a baseline that lives in the record rather than in git history removes that whole class of failure. Keeping both a git baseline and a recorded one grew patch upon patch (scope records, examined-set unions, commit-existence checks) and was dropped as needlessly complex.

### Alternative C: Cascade when `spec_write` edits a spec
- **Approach**: the tool that writes specs triggers the cascade on the requirements it touched.
- **Pros**: immediate, no diffing.
- **Cons**: misses every edit made outside the tool (amendments, PR feedback, hand or agent edits).
- **Why not chosen**: that gap is exactly what the issue wants closed.

## Agreed Approach

Alternative B, chosen by the user after review replaced the earlier A-plus-fallback design. The baseline is a record, not a commit: the plan gate records a content digest per requirement in scope, and every cascade `stale` record carries the digests it acknowledged. A requirement is pending when its digest at HEAD differs from the latest acknowledged digest. Git is used only to compute digests at a revision (HEAD, the integration merge-base, and `change_sync`'s two bases), through one shared function refactored from `changedRequirements` in `src/initiatives/sync.ts`. The existing cascade effects (stale record, untick of covering done units, move back to `define`) apply idempotently.

## Key Decisions

- **Edit with no done unit covering it (user decision):** the change still goes back to `define` when past it, and a `stale` record is posted naming the changed requirements with an empty or pending-only unit list; nothing is unticked. A spec approved at the define gate and edited afterwards must be approved again, as an answer that changed a requirement did before.
- **One cascade per edit (agreed):** the stale record carries the changed requirements with their content digest at HEAD, and its identity is derived from that set, so rerunning the detector for the same edit posts nothing new and re-stales nothing. A further edit of the same requirement is a new content digest and cascades again.
- **Integration updates are not edits (user decision, revised):** many changes and pull requests run in parallel, so a change branch is often updated from the integration branch, by `change_sync`, a hand merge or the forge's "Update branch" button, and conflicts get resolved. A requirement whose content at HEAD equals its content at `merge-base(HEAD, origin/<integration branch>)`, which the integration branch changed after the lock, does not count, whatever tool did the merge. Only when the integration branch is unknown or the merge-base cannot be computed does the recorded `Base` serve instead. A conflict resolution that keeps one side does not cascade; one that combines both sides does, because the spec really differs from what was approved.
- **Main-side requirement changes are not this change's cascade:** a requirement changed on the integration branch that a done unit covers is not re-verified here; that stays with `change_sync` (initiatives only today) and is recorded as a known gap.
- **Whitespace and moves (from the issue):** requirement content is compared as parsed text and scenarios without line numbers, as `change_sync` already does.
- **Removed flag (from the issue):** `/livespec answer … --changes …` is refused with a message naming the removed flag, not silently ignored.
- **Iteration counting unchanged (from the issue):** a spec-diff cascade that moves the change back from a later phase after a plan gate was approved counts as one iteration, derived from own `stale` comments.
- **Baseline is the recorded digests (user decision):** rebases and force-pushes do not matter, because nothing reads the lock commit for a plan gate approved after this release. The digests are computed when the plan gate request is built, at the HEAD the request is bound to, so the machine that completes the gate never needs that commit.
- **Changes locked before this release (user decision):** their plan gate has no digests. While the lock commit is in the repository, the digests are computed from it; when it is gone, the cascade fails closed: it never guesses and never skips silently; the change moves back to `define`, so the spec and the plan are approved again. `unit_finish` refuses outside `build`.
- **One detector (from the issue):** one function computes requirement digests at a revision with one content normalisation, and one comparison turns two digest maps into changed ids; `change_sync` (old base vs new base) and this cascade (acknowledged digests vs HEAD) both use them. No extra git ref is created. The plan gate comment and the plan gate request gain one field, the requirement digest map; LS-12 (#58, #62) moves it to the ledger with the other machine records.
- **Durable baseline and LS-12 (user decision):** the recorded digests are the durable baseline; LS-12 (#59) only moves them into the ledger with the other gate data. Both comments on #59 are posted.

## Open Questions

- None blocking. Left to the builder: the exact stale record id format, how the detector reports a skipped run on the card, and whether old `question` comments with `changes_requirement` need any read-side handling (they are history only and should simply be ignored).
