## Context

LS-04 left the seams that LS-05 fills:
- `pack.decisions: {}` waits for a registered sub-schema.
- `registerCheck` and `registerCardSection` take more entries.
- The marker kinds `gate`, `amendment`, `decision`, `question`, `stale` and `stuck` are already core kinds.
- `advancePhase` moves backward as well as forward.
- `spec_write` refuses `Units`.
- `nextStep` already puts an open blocking question before the gate.

Tools receive `ctx` (with `ui`, `hasUI` and `mode`) in `execute`, but none uses it yet.

Probe (j) showed that `ctx.ui.select`, `confirm` and `input` return exactly what the human did. Per the pi docs, `hasUI` is true in TUI and RPC modes and false in print and JSON modes. The agreed approach, decisions and non-goals live in `brainstorm.md` and are not repeated here.

## Goals / Non-Goals

**Goals:** a concrete module layout, the request lifecycle across sessions, the forge command grammar, how lock, frozen and stale state is derived from comments, how next-step precedence extends, and how rules are configured and merged.

**Non-Goals:** the non-goals in `brainstorm.md`, and any change to the forge adapters or the marker format.

## Decisions

### D1. Module layout

- `src/interaction/`:
  - `approver.ts`: the contract types.
  - `in-session.ts` and `forge.ts`: the adapters.
  - `commands.ts`: the pure parser of `/livespec …` command comments.
  - `requests.ts`: request comments and reading pending requests.
  - `chain.ts`: the adapter chain from config.
  - `complete.ts`: applies an answer to its subject.
- `src/decide/`:
  - `seam.ts`: `decide`.
  - `registry.ts`: `registerRule`, plus the `decisions` sub-schema and merge.
  - `records.ts`: the decision comment and the PR-body block.
  - `rules/tags.ts` and `rules/difficulty.ts`.
- `src/engine/`:
  - `gates.ts`: `registerGate` and gate evaluation, which is pure.
  - `locks.ts`: the lock, frozen and stale state, derived purely from own marked comments and the body.
  - `iterations.ts`: the `change_iterations` cap state.
- `src/core/`:
  - `unit-blocks.ts`: render, replace, insert and remove unit blocks, and set one field;
  - `question-lines.ts`: append, answer and reclassify question lines.

  Both keep every other line and its EOL.
- `src/tools/`:
  - `spec-gate.ts`, `plan-units.ts`, `unit-amend.ts`, `spec-question.ts` and `spec-stuck.ts`;
  - `approver-for.ts`: the chain for a tool call;
  - `register.ts`: the wrapper that polls before every livespec tool.

Pure derivation is kept apart from I/O, so `nextStep` stays pure and every rule is unit-testable.

### D2. One request lifecycle for every human decision

Each human decision has three steps: **request → answer → completion.**

- **Subject.** A request has a subject:
  - `gate:<phase|name>`;
  - `amend:<n>`;
  - `question:Q<n>`;
  - `stuck:S<n>`;
  - `decide:<point>.<subject>`.
- **In-session answers.** The in-session adapter answers inside the tool call. Completion then runs at once, and the tool result reports the outcome. Human notes in that result are wrapped as untrusted.
- **Forge answers.** The forge adapter writes an own marked comment `<!-- livespec:request:<id> -->`. Its yaml holds:
  - `kind`, `subject`, `mode` and `options`;
  - `head_sha`, the commit when the request was made;
  - `snapshot`, everything completion needs, such as unit digests for the plan gate, the proposed unit text for an amendment, the question text, or the failing waivable checks.

  Below the yaml block, the comment explains in plain text what is asked and lists the accepted commands. The parser ignores that text.
- **Request ids.** An id is `<subject-token>.<base36 epoch ms>`, for example `gate-plan.lx3k2a`. It is unique per issue and matches the marker id pattern.
- **Three states, all on the issue.**
  - **Pending:** a `request` comment exists with no `answer` comment.
  - **Applying:** an own `answer` comment exists with no result comment.
  - **Completed:** a result comment exists.

  Each result comment has kind `gate`, `amendment`, `question`, `stuck` or `decision` and carries `request: <id>`. The `answer` comment (new kind `answer`, id = request id) holds:
  - the full request: subject, snapshot and `head_sha`;
  - the answer: outcome, choice, notes, overrides, changes-requirement, class, by, at, adapter and answer comment;
  - the validation verdict: `valid` or `superseded`.

  In-session answers write the `answer` comment directly, with no `request` comment. A crash mid-completion therefore leaves a durable answer for any later session to finish.
- **Validation happens once, before the answer is recorded.** It re-checks what the human saw:
  - **Gate:** HEAD equals `head_sha`, and the gate digest still matches. The gate digest is a sha256 of the issue body with the `## Questions` section removed and unit status lines blanked. The refusal conditions of D7 must also still hold, ignoring the request being completed.
  - **Amendment:** each affected unit's current digest and done state equal the snapshot, and the resulting plan is valid (D9a).

  A failed check records `superseded` in the `answer` comment, and the result comment then carries `superseded: true` with no effect.
- **Applying is idempotent, and the result comment is written last.** Effects run in a fixed order. Each one is skipped when the current state already shows it applied:
  - a body edit, when the body already holds the target text;
  - a `stale` or `decision` comment, when one with the same id and `request` exists;
  - a phase move, through `advancePhase`, which is idempotent.

  An applying request is never validated again, so partial effects of its own cannot supersede it. Any failure leaves it applying, and the next poll (D3) or the next livespec tool finishes it.
- **The gate advance is derived.** Phase advance after a gate is not an applying step. `nextStep` reports `advance` when the **valid gate result** of the current phase is approved and the phase is not `ship`, and the existing `applyAdvance` in `Session.refresh` moves the label. A failed move therefore retries on every refresh.
- **Valid gate result.** It is the latest own `gate` comment for that phase that is newer than the latest own `stale` comment listing the phase. Superseded results count as "no result". An older approval never reopens a phase after a newer `changes_requested`, `dismissed` or `stale`.
- **One per subject.** Only one request per subject may be pending. A second request for that subject is refused, and the human ends a pending one with `/livespec dismiss`.
- **Why the issue holds the requests.** The issue is the only state that survives sessions and machines (ADR 0002). Session memory would lose forge answers (Alternative B in `brainstorm.md`).

### D3. Polling

`pollApprovals(session)` runs at `session_start` after the forge connects, at `/livespec next`, and at the start of every livespec tool, through the `registerLivespecTool` wrapper (`src/tools/register.ts`).

1. It skips when the forge is read-only or blocked.
2. It returns at once when the snapshot shows no pending or applying request.
3. Otherwise it drops the comments cache for the issue and reads the comments fresh.
4. First it finishes every applying request (D2).
5. Then, for each pending request, it runs `parseCommand` on plain comments created after the request.
6. It calls `getPermission(author)` once per author per poll.
7. It records the first valid answer as an `answer` comment, applies it, then rebuilds the snapshot.

Errors are recorded on the session and never thrown into a tool.

### D4. Forge command grammar

Only the first line of a comment that starts with `/livespec ` is read. Tokens are split on whitespace, and the rest of the line is free text.

| Command | Answers | Result |
|---|---|---|
| `/livespec approve [notes]` | a `gate:` or `amend:` request without failing waivable checks | `approved`, or `approved_with_notes` when notes are given |
| `/livespec changes <notes>` | a `gate:` or `amend:` request | `changes_requested` |
| `/livespec dismiss [notes]` | any pending request (gate, amend, question, stuck or decide) | `dismissed` |
| `/livespec choose <option-id> [notes]` | a request with `options` (stuck, decide, or a gate with failing waivable checks, where `waive` is an option) | approved with `choice`; at a gate, `waive` records every failing waivable check as waived |
| `/livespec answer Q<n> <text> [--changes <capability>/Requirement: <name>] [--class blocking\|non-blocking]` | `question:Q<n>` | answered; `--changes` takes the rest of the line after it |
| `/livespec class Q<n> blocking\|non-blocking` | the class of an open question | reclassified; the question stays open |
| `/livespec set U<n> difficulty <low\|medium\|high>` and `/livespec set U<n> tags <a,b,…>` | the pending `gate:plan` or `amend:` request | an override applied only if that request is approved |

**Effective mode of a question request.** It is derived from the question's current class in the body, not from the mode stored in the request. Reclassifying a question with `/livespec class` therefore turns its pending blocking request into an async one at once.

**Which request a command targets.** `approve`, `changes` and `choose` target the single pending `gate:` or `amend:` request. If none is pending, they target the single pending `stuck:` or `decide:` request. When several could match, the command is ignored with a card warning.

**Ignored comments.** A command comment is ignored, with a card warning that names the reason, when:
- its author lacks `write` or `admin`;
- it was created before the request;
- it cannot be parsed;
- it uses `approve` while waivable checks fail.

**Edits.** Edits after completion are ignored. The result records the answering comment's `id`, `author` and `updatedAt`.

**Same login.** Commands from the plugin's own login are accepted (`brainstorm.md`). The agent posting commands itself through bash is a known gap until LS-06.

### D5. In-session adapter

**Availability.** The adapter is available when `ctx.hasUI` is true.

**Gate and amendment requests:**
1. `ui.select(summary, labels)`. The labels are approve, request changes, dismiss, and `waive` options when waivable checks fail.
2. For changes, `ui.input` collects notes. For approve, `ui.select` asks "Add notes?" (yes/no as labels, since `confirm` cannot tell no from cancel), then `ui.input`.
3. At the plan gate and amendment gates, the adapter asks "Adjust Difficulty or Tags?" as a `select`. If yes, the human picks a unit and edits the values through `select` and `input`.

**Question requests:**
1. `select`: answer now, or answer later (non-blocking).
2. `input`: the answer.
3. `select`: does the answer change a requirement? The options are no, the requirement names parsed from the declared capabilities' living specs, and "other", which opens an `input`.

**Stuck and decide requests.** `select` over the options.

**Escape or cancel.** A cancelled dialog (`undefined`) is `dismissed`.

**"Answer later".** The question becomes non-blocking and the chain moves on to the next adapter. If there is none, the question stays open, and `spec_question` with `reask` sends it again.

**`by`.** The current forge login with `adapter: in-session`. pi exposes no separate human identity.

### D6. Adapter chain and config

- **Where the setting comes from.** `interaction.adapter` is a list of `in-session` and `forge`. Project config wins over user config, and both default to `[in-session]`. Unknown names are config warnings and are dropped. An empty list counts as unset and falls through project → user → default.
- **How the chain runs.** The chain tries the adapters in order and skips any that is unavailable: in-session without UI, or forge while it is unconnected, read-only or blocked. When none is available, the tool refuses and names the config key.
- **Doctor.** The approver check reports the list, its source, and the adapter that would answer now.

### D7. Gates

**Registration.**
- `registerGate(name, { checks, options? })` adds named gates.
- Phase gates come from the pack: the `gate` value of each phase and its `checks`.
- `registerCheck(name, fn, { waivable? })` marks a check as waivable. Existing checks are not waivable.
- Waivers apply to the gated phase only, per check name, for as long as that gate result stays valid.

**`spec_gate <target>` refuses when:**
- the target is neither the current phase nor a registered named gate;
- the phase gate is `none`;
- a blocking question is open;
- a stuck report is open;
- the iteration cap is reached and no stuck answer follows it;
- a request for the subject is pending;
- the tree is dirty, because a human gate must see a commit;
- it is the plan gate after a lock and a unit is frozen or stale;
- a check fails that is not waivable.

**What happens on a pass.**
- A `self` gate writes the gate comment with `by: livespec`, and the derived advance moves the phase.
- A `human` gate sends the request through the chain, with the phase's review payload.

**Review payload.** Every gate request carries a summary plus links and files. In-session shows the summary in the dialog. Forge puts the summary in the request comment's plain text. Per phase:
- **define:**
  - the `Capabilities` line;
  - the `Product impact` line;
  - the Proposal, shown as its first lines plus a link to the issue;
  - the spec diff, as `git diff --stat <Base>..HEAD -- specs/` plus the files.
- **plan:**
  - one line per unit, with id, title, `Difficulty`, `Tags` and `Covers`;
  - one line per decision record, giving its reason and any `agent_additions`.
- **ship:**
  - the `## Durable docs` table;
  - the latest review result, when a registered payload provider gives one (LS-08).
- **Named gates and amendments:** the summary their registration or tool gives; for amendments, only the affected units, old and new.

Later specs extend a phase's payload with `registerGatePayload(phase, fn)`.

**Applying a gate answer.**
The effects run first, and the result comment is written last (D2):
1. On `approved`, at the plan gate or an amendment gate: apply the overrides (D10), through a body edit and override records.
2. On `changes_requested`: write a `stale` comment with id `<request id>` that lists every phase after the gated phase.
3. Write the `gate` comment with `request`, `phase` or `gate`, `outcome`, `choice`, `notes`, `by`, `at`, `adapter`, `head_sha`, `waivers`, `answer_comment` and, for the plan gate, `locked` (the digests in the body after the overrides) and `agent_skills`.

**After completion.**
- **Phase gates:** an approved valid gate result (D2) makes `nextStep` report the successor as `advance`, except at `ship`.
- **Named gates:** never advance.
- **On `dismissed`:** the card asks the agent to ask the human how to proceed.

**What the human saw changed.** Validation (D2) checks HEAD, the gate digest and the refusal conditions, ignoring the request being completed. When any of them changed, the gate comment gets `superseded: true`, nothing advances, and the card asks for the gate again.

The agent-skills commit is the basename of the active tree path.

### D8. Units, lock, frozen and stale (`locks.ts`, pure)

**Lock.**
- The lock starts from the latest own `gate` comment for `plan` with outcome approved and not superseded. Its `locked` map is the base.
- Every later approved `amendment` is then applied in comment order:
  - edit: set the digest;
  - add: insert the unit;
  - drop: delete the unit.

**Frozen.** A unit is frozen, once a lock exists, when it is in the body and either has no locked digest or its current `unitDigest` differs from the locked one.

**Stale.**
- **Units:** a unit is stale when it is named in a `stale` comment's `units`, and no approved amendment for that unit follows that comment.
- **Phases:** a phase is stale when it is listed in a `stale` comment's `phases`, and no approved, non-superseded gate for it follows that comment.

**Scope.** Lock-derived blocks (frozen, stale) apply only to phases at or after the phase whose `outputs` include `issue#Units`, reached through `requires`. In define after a cascade they do not block define work.

### D9. `plan_units`

**Refusals.** The tool refuses:
- outside the phase that outputs `issue#Units`;
- after a lock (use `unit_amend`);
- on a dirty tree;
- when an approval request is pending.

**Input.** One structured object per unit: `title`, `covers`, `files`, `done_means` `[{label, text}]`, `scenarios` `[{label, ref}]`, `depends`, `verify`, optional `kind` and `extra_tags`. There is no `Difficulty` or `Tags` field. Ids are assigned `U1…Un`, and every status line is `- [ ] pending`.

**Steps:**
1. **Reconcile the base.** If the issue `Base` differs from the branch's `livespecBase` config and is an ancestor of HEAD, set the config to the issue `Base`. This finishes a previous run whose outcome was unknown.
2. Run `decide("tags")` and then `decide("difficulty")` per unit. Both are pure computations, and nothing is posted yet.
3. Render the complete units, with the computed `Difficulty` and `Tags`, then validate them with `validateUnits` and `checkDoneMapsScenarios`. Any error refuses with the LS-02 results.
4. Fetch the integration branch, then run `git merge --no-ff --no-edit origin/<integration>` (fast-forward is disabled when a merge is needed; an already up-to-date branch gets no new commit). On a conflict, `git merge --abort` and refuse. The new `Base` is `rev-parse origin/<integration>`, which is an ancestor of HEAD after the merge.
5. Post the decision records.
6. Write `## Units` and `Base` in one version-checked body write.
7. Set `branch.<branch>.livespecBase` to the new `Base`, only after the write succeeded.

**Failure handling.** Like `change_start`:
- **Conflict:** nothing changes in config. The local merge commit stays, which is harmless because `Base` stays an ancestor of HEAD, and a rerun merges as a no-op.
- **Thrown error:** re-read the issue. If it shows both the new `Base` and exactly the rendered `## Units`, set the config and report success. Otherwise, report that rerunning `plan_units` will reconcile.

The config and the issue `Base` therefore never disagree after a successful run, and step 1 repairs an unknown outcome.

**Why records come before the body.** A failed body write then leaves only harmless records, which are keyed by unit digest. A failed record write leaves no unrecorded outcome in the body.

`Git` gains `merge(ref)`, which returns `ok` or `conflict`, `mergeAbort()`, and `isAncestor(a, b)`.

### D9a. `unit_amend` validation

**Before sending the request,** `unit_amend` builds the resulting body (edit, add or drop), with the classification computed for edited and added units. It validates the whole resulting plan with `validateUnits` and `checkDoneMapsScenarios`, and refuses on any error.

**A drop of a unit that another remaining unit lists in `Depends` is refused.** The tool names the dependents. The agent first amends those dependents to drop the dependency, each one approved separately.

**Validation repeats as part of the D2 check** when the answer is recorded.

### D10. Decision seam and records

- **Contract.** `decide(point, facts, deps)` runs the registered rule.
  - A rule returns `{ outcome, reason }` or `{ ask: { summary, options } }`.
  - `ask` goes through the approver chain with subject `decide:<point>.<subject>`. A pending answer returns `{ status: "pending", requestId }`, and completion writes the record with `source: human`.
- **Record.** A `decision` comment with id `<point>.<subject>`, for example `tags.U3`. Its yaml holds `point`, `subject`, `digest`, `source`, `outcome`, `facts`, `reason`, `agent_additions` and `overridden_by`.
  - `facts` is replaced by `facts_hash` (sha256 of its yaml) when its yaml exceeds 2,000 characters.
  - The last record for an id wins.
- **Small-fix PR body format.** A block whose first line is `<!-- livespec:decision:<point> -->`, followed by one fenced yaml block with the same fields. `formatDecisionBlock` and `parseDecisionBlocks` are exported and tested, and LS-09 writes the block.
- **Override.** At an approved plan or amendment gate, an override:
  - rewrites the unit's `Difficulty` or `Tags` line through a byte-preserving line replace;
  - posts a new record with `source: human`, `outcome` set to the new value, and `overridden_by: { by, at, from }`.
- **`unit-classification` check.** Registered for the plan phase and added to the default pack. It reports an error when a unit's `Difficulty` or `Tags` differs from the latest record for that unit, or when a unit has no record. This is how a tag removed from the body, by the agent or anyone, is caught.

### D11. Rule config, validation and merge

- **One sub-schema.** `registerRule(point, { validate, merge? }, fn)` registers one `decisions` sub-schema that dispatches on the point key.
  - An unknown point is an error.
  - Every point needs `mode: rule`.
  - `mode: jev` is an error that says it is reserved for a later version.
- **Merge.** The pack merge of `decisions` calls the registered `merge(base, override)` per point, and falls back to a one-level merge for points without one. The `tags` merge takes the union of the globs and keywords per tag, keeping order and dropping duplicates. This changes the flow-pack override requirement for `decisions` only.
- **Tags rule.** A unit gets a tag when one of its `Files` matches a glob of that tag (`matchGlob`), or a keyword of that tag occurs in the unit text as a whole word or phrase, ignoring case. The unit text is the title, `Covers`, and every `Done means` text.
  - The order is the order of the tags in the config. Agent `extra_tags` must be kebab-case. They are appended without duplicates, and those the rule did not produce are listed in `agent_additions`.
  - Matching whole words keeps `auth` from tagging `author`.
- **Difficulty rule.**
  - `high` when there is a `security` or `migration` tag, the unit covers more than one distinct capability, or it has more than 4 `Files`;
  - otherwise `low` when it has exactly 1 file and no tags;
  - otherwise `medium`.

### D12. Questions, cascade, iterations and stuck reports

- **`spec_question`.**
  - Takes `{ text, class? }` and appends `- [ ] Q<n> (<class>): <text>` under `## Questions`, with `n = max + 1` and one line.
  - `{ reask: "Q<n>" }` sends an open question again.
  - The mode is `blocking` for blocking questions and `async` otherwise.
- **Completion of an answer.**
  - The question line becomes `- [x] Q<n> (<class>): <text> — Answer: <one-line answer>`.
  - A `question` result comment holds `request`, `class`, `answer`, `changes_requirement`, `by`, `at`, `adapter` and `answer_comment`.
  - When `changes_requirement` is set, the cascade also runs:
    - it moves the change back to define when it is past define;
    - it writes a `stale` comment with `reason: Q<n>`, `phases` (`define` and every phase after it) and `units` (those whose `Covers` contains that requirement);
    - it unticks each done stale unit with `untickUnit`.

  The order is: one body write (answer line plus unticks, skipped if already applied), then the `stale` comment with id `Q<n>` (skipped if it exists, with `after_plan` set as defined below), then `advancePhase(define)`, and last the `question` result comment.
- **The cascade's `stale` comment.** It lists `define` and every phase after it in `phases`, so an old define approval cannot reopen define (D2, valid gate result).
- **`after_plan`.** It is true only when the cascade actually moves the change back from a phase after define and an approved plan gate exists. A second answer while the change is already in define does not count.
- **`change_iterations` is derived, not stored.** It is the number of own `stale` comments with `after_plan: true`. Deriving it means a retried completion cannot count twice. The card shows it with the cap like any other counter.
- **Iteration cap blocking.** Blocking holds when the count is at least `loops.change_iterations` and no stuck answer is dated after the latest `after_plan` stale comment. The same predicate drives the next step, which asks for `spec_stuck`, and gate refusal. A stuck answer clears the block until the next increment.
- **`spec_stuck`.**
  - Input: `{ where, tried: [{ text, link? }], hypothesis, options: [{ id, label }] (2–3), recommended }`.
  - It writes a `stuck` comment with id `S<n>`, then sends a blocking request with those options.
  - Completion writes a `stuck` comment with id `S<n>-answer`.
  - While a report is unanswered, the next step says to wait, and every gate refuses.

### D13. Next-step precedence and the card

The new order is:

1. label repair;
2. not started;
3. **open stuck report**: wait for the human's choice;
4. **pending blocking request**: wait for the answer, naming the adapter;
5. **iteration cap blocking** (the D12 predicate, which a later stuck answer lifts): send a stuck report;
6. open blocking question;
7. **frozen or stale units**, in the lock scope: amend them with `unit_amend`;
8. missing output;
9. failing check;
10. next unit;
11. gate.

The gate sentence also covers the latest gate result for the current phase:
- `changes_requested`: revise and request the gate again;
- `dismissed`: ask the human how to proceed;
- superseded: request it again;
- `ship` approved: ready to ship.

The `ChangeState` additions are `requests`, `lock` (with `lock.gates`) and `iterations` (with `iterations.stuckOpen`). They are all derived from own marked comments by pure functions. `NextStep` gains `pending`, `frozenUnits` and `staleUnits`. The card adds an `approvals` section: pending requests, frozen and stale units, the open stuck report, and ignored-command warnings. Forge text in it is wrapped as untrusted.

## Risks / Trade-offs

- [The agent posts `/livespec approve`, or a marked `gate` comment, from the plugin's login through bash] → This is a known gap until LS-06's guard against direct forge writes. Gate comments record `answer_comment` and `adapter` for audit.
- [The agent edits `.pi/livespec/flow.yaml` to lower a gate] → This is a known gap until LS-06's guard on `.pi/livespec/`.
- [An RPC client with no human behind it answers dialogs] → This is accepted. An RPC front end belongs to the operator. Doctor names the adapter in use.
- [Long gate summaries in a `select` title render poorly in the TUI] → Keep summaries short, with unit lines and a link to the issue. The full detail lives on the issue.
- [Polling before every tool adds forge reads] → Polling only reads fresh when the snapshot shows a pending request, and permission lookups are cached per poll.
- [The merge in `plan_units` creates a local merge commit the agent did not plan] → This is the spec's rule (`Base` is an ancestor of HEAD). A dirty tree and conflicts are refused, and a conflict is aborted, so nothing is left half-merged.
- [Records are written before the body] → Orphan records are possible after a body conflict. They are keyed by digest, so the `unit-classification` check ignores records for digests that are not in the body.

## Migration Plan

- There is no data migration. Changes in flight from LS-04 have no lock, no records and no requests.
- The `unit-classification` check reports units that `plan_units` did not write. Re-running `plan_units` fixes them, because no lock exists yet.
- The default pack fixture is updated in the same commit.

## Open Questions

- The default tag map is still unconfirmed for target projects. It is not blocking.

## Errata (#20)

- D3: polling runs through the `registerLivespecTool` wrapper (`src/tools/register.ts`), not a `prepareWrite` helper.
- D5: approve notes use a `select` ("Add notes?"), not `confirm`; "Adjust Difficulty or Tags?" is a `select`; a cancelled dialog is `undefined` only.
- D9: the merge is `git merge --no-ff --no-edit`; an up-to-date branch gets no new commit.
- D13: `ChangeState` additions are `requests`, `lock` (with `lock.gates`) and `iterations` (with `iterations.stuckOpen`).
- Removed in code: `Approver.poll`, `ApproverUI.confirm`, `GateSnapshot.digests`, `LockState.stalePhases`.
- Where the setting comes from: an empty `interaction.adapter` list counts as unset and falls through project → user → default (not straight to the default).

