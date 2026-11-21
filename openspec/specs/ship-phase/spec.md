# ship-phase Specification

## Purpose

Defines the ship phase: the change diff and the reviewed HEAD, the `Durable docs` table and the `durable-docs` rule and check, `change_ship` opening exactly one pull request, `change_push` for reviewed fixes, the ship tools in child sessions, and the ship phase's next steps.

## Requirements

### Requirement: Change diff at ship
The ship tools and the `durable-docs` check SHALL use the **change diff** `git diff <M>..HEAD`, where `M` is `git merge-base HEAD origin/<integration branch>` after fetching the integration branch. When the fetch or the merge base fails, `M` SHALL be `Base`. Changed files SHALL include deleted files and both paths of a rename.

#### Scenario: Integration merge excluded
- **WHEN** the change branch merged `origin/main`, which brought `src/other.ts` from another change
- **THEN** `src/other.ts` is not in the change diff

#### Scenario: Fetch fails
- **WHEN** fetching the integration branch fails
- **THEN** the change diff is `git diff <Base>..HEAD`

### Requirement: Reviewed HEAD
The **reviewed SHA** SHALL be the `head_sha` of the valid approved `review` gate result. The reviewed SHA SHALL be taken from the latest approved `review` gate result not listed by a newer `stale` comment, without comparing it to HEAD. HEAD SHALL count as reviewed against a SHA `s` when it equals `s`, or when every commit on the first-parent chain from `s` to HEAD is a merge commit whose first parent is the commit before it, whose second parent is an ancestor of `origin/<integration branch>`, and whose tree equals the tree `git merge-tree --write-tree` computes for its two parents without conflicts. Any other commit, a merge with conflicts, or a merge whose tree was edited SHALL make HEAD unreviewed. When git cannot run `merge-tree --write-tree`, only equality SHALL count, and the refusal SHALL say why.

#### Scenario: Equal to the reviewed SHA
- **WHEN** the review gate's `head_sha` is `c3` and HEAD is `c3`
- **THEN** HEAD is reviewed

#### Scenario: Commit after review
- **WHEN** the review gate's `head_sha` is `c3` and a commit `d4` that is not a merge follows it
- **THEN** HEAD is not reviewed

#### Scenario: Clean integration merge
- **WHEN** after `c3` the only commit is a merge of `origin/main` with no conflict and no hand edit
- **THEN** HEAD is reviewed

#### Scenario: Clean merge while the integration branch moved
- **WHEN** after `c3` the only commit on the first-parent chain is a clean merge of `origin/main`, which brought two new non-merge commits of other changes
- **THEN** HEAD is reviewed

#### Scenario: Conflicted merge
- **WHEN** after `c3` the only commit is a merge of `origin/main` whose conflicts were resolved by hand
- **THEN** HEAD is not reviewed

### Requirement: Durable docs output
The `ship` phase output `issue#Durable docs` SHALL be present when the `## Durable docs` table has at least one row, or when the `durable-docs` rule needs no row: the change diff changes nothing under `specs/` other than files under `specs/decisions/`, declares no `new` capability, and changes no file under a capability's `paths`. While it is missing, the next step SHALL name `docs_table`.

#### Scenario: Missing table
- **WHEN** the change is in `ship`, the diff changes `specs/rate-limit/spec.md`, and the table has no row
- **THEN** the next step asks to write the Durable docs table with `docs_table`

#### Scenario: Nothing durable touched
- **WHEN** the change diff changes only `tests/fixture.json`, which no capability's `paths` match, and declares no capability
- **THEN** the output counts as present with an empty table

### Requirement: Durable docs table tool
`docs_table` SHALL replace the rows of the change issue's `## Durable docs` table with the rows it is given, each a file and a status `updated` or `not needed — <reason>`, as `| File | Status |` rows. It SHALL refuse, writing nothing, when the change is not in `review` or `ship`, when a row is `updated` and its file is not in the change diff, when a row is `not needed` and a hard requirement of the `durable-docs` rule covers it, or when a `not needed` row has an empty reason. The write SHALL be a versioned body write that leaves every other section byte for byte.

#### Scenario: Updated row not in the diff
- **WHEN** `docs_table` is called with `specs/rate-limit/spec.md` `updated` and the change diff does not touch that file
- **THEN** the tool refuses, naming the file, and the issue is unchanged

#### Scenario: Not needed with a reason
- **WHEN** `docs_table` is called with `specs/glossary.md` `not needed — no new term`
- **THEN** the table holds the row `| specs/glossary.md | not needed — no new term |`

#### Scenario: Hard rule row
- **WHEN** the change declares `new [cache]` and `docs_table` marks `specs/product.md` `not needed — small`
- **THEN** the tool refuses, naming the `durable-docs` requirement for a new capability

### Requirement: Durable docs rule and check
The `durable-docs` decision point SHALL be registered with `registerRule`, configured as `decisions.durable-docs: { mode: rule }`, and MUST NOT ask. From facts built by code (the change diff's files, the `Capabilities` line, each living spec's capability and `paths`, the table rows) it SHALL return errors and confirmation items:
- a `new` capability and no `updated` row for `specs/product.md`: error;
- `specs/constraints.md` changed and no file added under `specs/decisions/` in the diff: error; with one, a confirmation item naming both files;
- a changed file matching a capability's `paths` and no `updated` row for `specs/<capability>/spec.md`: a confirmation item naming the capability and the files, until LS-10 adds the `behavior-change` record;
- a changed file under `specs/` other than `specs/decisions/` with no row, an `updated` row not in the diff, or a `not needed` row a hard requirement covers: error.

The check `durable-docs` of the `ship` phase SHALL report each error with severity `error` and each confirmation item with severity `warning`; it is not waivable. The ship gate payload SHALL hold a "Needs your confirmation" section with every confirmation item, every `not needed` reason verbatim, and each new decision file; approving the ship gate SHALL be the human's confirmation.

#### Scenario: Capability code without a spec row
- **WHEN** `specs/rate-limit/spec.md` lists `paths: [src/limit/**]`, the diff changes `src/limit/cap.ts`, and the table marks `specs/rate-limit/spec.md` `not needed — refactor`
- **THEN** the check reports a warning, and the ship gate payload asks the human to confirm that `rate-limit` behavior did not change and shows the reason `refactor`

#### Scenario: Constraints without a decision
- **WHEN** the diff changes `specs/constraints.md` and adds nothing under `specs/decisions/`
- **THEN** the check reports an error and `spec_gate ship` refuses

#### Scenario: Constraints with a decision
- **WHEN** the diff changes `specs/constraints.md` and adds `specs/decisions/0007-cap.md`
- **THEN** the check reports no error with only a `specs/constraints.md` `updated` row, and the ship gate payload lists both files for explicit approval

#### Scenario: Changed durable doc without a row
- **WHEN** the diff changes `specs/glossary.md` and the table has no row for it
- **THEN** the check reports an error naming `specs/glossary.md`

### Requirement: Ship tool
`change_ship` SHALL refuse, pushing and opening nothing, unless all of these hold:
- the change is in `ship`, the tree is clean, the current branch is the issue's `Branch` line, and the issue has no `PR` line;
- the ship gate has an approved result not listed by a newer `stale` comment, and HEAD is reviewed against its `head_sha`;
- HEAD is reviewed (see "Reviewed HEAD");
- no human comment (a human voice as pull-request-feedback "Human voices" defines it: not own, by a `write` or `admin` author) on the change issue was created or edited after the valid ship gate result was written, and the issue's gate digest equals the one the ship gate request recorded;
- every file of the change diff is in some unit's `Files` (exact or glob) or under `specs/`;
- no open pull request has the change branch as head, other than one the current account opened whose body holds `Refs #<change>`.

When the freshness condition is the only reason to refuse, `change_ship` SHALL write a `stale` comment listing `ship`, so the next step asks for the ship gate again, and SHALL do nothing else.

When nothing refuses, `change_ship` SHALL push the branch through `guardedPush`, open exactly one pull request from the change branch to the integration branch, and write `PR: #<n>` in the ownership lines. An open pull request the current account opened with `Refs #<change>` SHALL be adopted instead of opening a second one. The pull request body SHALL hold the Proposal's first paragraph, the units with their status, the Durable docs table, the review result of the latest routed round, and the line `Refs #<change>`, and MUST NOT hold a closing keyword (`close`, `fix` or `resolve` in any form) followed by an issue reference; such a phrase taken from the Proposal SHALL be rewritten to `Refs #<n>`. After opening it, `change_ship` SHALL post an own `ship` record with id `ship.<pr>.<pushed head>`, holding the pull request, the pushed head and the confirmation items the ship gate showed. The marker kind `ship` SHALL be registered.

#### Scenario: One pull request
- **WHEN** every refusal condition is false and `change_ship` runs
- **THEN** the branch is pushed, exactly one pull request is open for the change branch, its body says `Refs #<change>`, and the issue's ownership lines hold `PR: #<n>`

#### Scenario: Commit after the reviewed SHA
- **WHEN** the review gate's `head_sha` is `c3` and a non-merge commit `d4` is HEAD
- **THEN** `change_ship` refuses, naming `d4` and `c3`, and nothing is pushed

#### Scenario: File outside every unit
- **WHEN** the change diff modifies `src/extra.ts`, which no unit's `Files` lists and which is not under `specs/`
- **THEN** `change_ship` refuses, naming `src/extra.ts`

#### Scenario: Another pull request open
- **WHEN** someone else opened a pull request from the change branch
- **THEN** `change_ship` refuses, naming that pull request

#### Scenario: Retry after a partial ship
- **WHEN** a previous `change_ship` opened pull request 41 and failed before writing `PR: #41`
- **THEN** a second `change_ship` adopts pull request 41, writes `PR: #41`, and opens no other pull request

#### Scenario: Human comment after the ship gate
- **WHEN** after the ship gate result was written a human commented on the change issue
- **THEN** `change_ship` refuses as stale, writes a `stale` comment listing `ship`, and the next step asks to request the ship gate again

#### Scenario: Forge approval then ship
- **WHEN** a writer approved the ship gate with `/livespec approve` on the forge and nothing else changed
- **THEN** `change_ship` does not count the approval comment as new input and opens the pull request

#### Scenario: Closing keyword in the Proposal
- **WHEN** the Proposal's first paragraph says "Closes #12"
- **THEN** the pull request body says "Refs #12" and holds no closing keyword

#### Scenario: Clean merge after the ship gate
- **WHEN** the ship gate was approved at `c3` and a clean merge of `origin/main` is HEAD
- **THEN** `change_ship` does not refuse for the ship gate or for review, and opens the pull request

#### Scenario: Ship gate not approved
- **WHEN** the ship gate has no valid approved result
- **THEN** `change_ship` refuses, naming the ship gate

### Requirement: Push tool
`change_push` SHALL first poll pull request feedback (see pull-request-feedback) and refuse when the poll fails or ingests new feedback. It SHALL then refuse, pushing nothing, unless the change is in `ship`, the `PR` line names an open pull request that is not merged, the tree is clean, the current branch is the issue's `Branch` line, the pushed head exists, HEAD is reviewed, every file of the change diff is in some unit's `Files` or under `specs/`, HEAD descends from the pushed head, and the `durable-docs` check reports no error. When the commits from the pushed head to HEAD change a file under `specs/`, or the `durable-docs` check now has a confirmation item the latest `ship` record does not list, `change_push` SHALL also require a valid approved ship gate result whose `head_sha` is HEAD, and refuse naming the ship gate otherwise. It SHALL then push through `guardedPush` and post an own `ship` record with the new pushed head and the confirmation items shown. When HEAD equals the pushed head, it SHALL report that there is nothing to push.

#### Scenario: Unreviewed commits refused
- **WHEN** a fix commit `e5` follows the reviewed SHA and no review gate passed at `e5`
- **THEN** `change_push` refuses, naming `e5`, and nothing is pushed

#### Scenario: Reviewed fix pushed
- **WHEN** the review gate passed again at `e5` and HEAD is `e5`
- **THEN** `change_push` pushes `e5` to the open pull request's branch

#### Scenario: Feedback arrived
- **WHEN** a human left a new review comment on the pull request and `change_push` runs
- **THEN** the comment is ingested as a feedback round, `change_push` refuses, and nothing is pushed

#### Scenario: Fix touches constraints
- **WHEN** the reviewed fix commits change `specs/constraints.md` and add a decision file, and no ship gate was approved at HEAD
- **THEN** `change_push` refuses, naming the ship gate, and the next step asks for the ship gate

#### Scenario: Remote moved
- **WHEN** the pushed head is not an ancestor of HEAD
- **THEN** `change_push` refuses and names the divergence

### Requirement: Ship tools in child sessions
`docs_table`, `change_ship`, `change_push` and `change_close` MUST refuse in a child session.

#### Scenario: Child ships
- **WHEN** a child session calls `change_ship`
- **THEN** the tool refuses and nothing is pushed

### Requirement: Ship next steps
In the `ship` phase, after the checks rule and before the gate, the next step SHALL be, in order:
1. HEAD is not reviewed: new commits need review, with `advance: review`;
2. no `PR` line: the ship gate steps; an approved ship gate says to run `change_ship`;
3. HEAD equals the pushed head: wait for a human to merge the pull request on the forge;
4. `change_push` would require the ship gate (see "Push tool") and it has no valid approved result at HEAD: the ship gate steps;
5. otherwise: run `change_push`.
A merged or closed pull request is handled earlier, by change-close "Pull request outcome".

#### Scenario: Waiting for merge
- **WHEN** the change is in `ship` with `PR: #41` open and HEAD equal to the pushed head
- **THEN** the next sentence says to wait for a human to merge #41 on the forge

#### Scenario: Unreviewed commits go back to review
- **WHEN** the change is in `ship` with `PR: #41` open and a new commit after the reviewed SHA
- **THEN** the next sentence says the new commits need review and reports `review` as the phase to advance to

#### Scenario: Fix needs the ship gate again
- **WHEN** the change is in `ship` with `PR: #41` open, the review gate passed at HEAD, the fix commits changed `specs/constraints.md`, and the only approved ship gate is at an older HEAD
- **THEN** the next sentence says the change is ready for the `ship` gate, not to run `change_push`

#### Scenario: Reviewed fix ready to push
- **WHEN** the change is in `ship` with `PR: #41` open and the review gate passed at HEAD, which is ahead of the pushed head
- **THEN** the next sentence says to run `change_push`
