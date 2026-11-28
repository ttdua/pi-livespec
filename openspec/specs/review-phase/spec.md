# review-phase Specification

## Purpose

Defines the review phase: `spec_review` and its stages, reviewer selection with personas and tags re-checked on the diff, the `constraints-not-weakened` check, `Verify` of every unit at review, the `review_rounds` cap, the `review-clean` gate, the review next steps and the optional `simplify` unit.

## Requirements

### Requirement: Review tool
`spec_review` SHALL run one review round of the whole change in stages: start, review, aggregate, verify, route. Each stage SHALL be skipped when its record already exists for the current HEAD, so a repeated call resumes the round where it stopped. A round's number SHALL be the count of aggregate records plus one; a `review-run` record for a HEAD that is no longer HEAD SHALL be replaced by a new `review-run` with the same number, except a `review-run` with `source: pull-request` (see pull-request-feedback), which SHALL never be replaced: its aggregate and route stages SHALL run at its recorded head, and the next round starts at the new HEAD. `spec_review` MUST refuse, writing nothing, when:
- the call is made in a child session;
- the change is not in a phase whose `review` entries exist (the `review` phase of the default pack);
- a unit is not done;
- the change has no `Base`, or `git diff <Base>..HEAD` fails, naming the cause;
- the working tree is dirty;
- a blocking question is open, a stuck report is unanswered, or a blocking request is pending;
- the start stage would run and the `review_rounds` cap blocks (see "Review round cap"); the later stages of a round already started SHALL still run;
- a unit's `Verify` command is blocked by the guard.

#### Scenario: Round started
- **WHEN** the change is in `review`, every unit is done, the tree is clean and `spec_review` runs
- **THEN** one `review-run` record for round 1 records HEAD, the selected subjects, the re-checked tags, each unit's `Verify` result and the parent findings

#### Scenario: Resumed after an interruption
- **WHEN** round 1's `review-run` and the `change` reviewer's completed summary at HEAD exist, and `spec_review` runs again
- **THEN** no new `review-run` is posted and the `change` reviewer is not launched again

#### Scenario: No Base
- **WHEN** the change issue has no `Base` line and `spec_review` runs
- **THEN** the tool refuses, says the change has no `Base`, and writes nothing

#### Scenario: Unit not done
- **WHEN** U2 is pending and `spec_review` runs
- **THEN** the tool refuses, names U2, and writes nothing

#### Scenario: New HEAD restarts the round
- **WHEN** round 2's `review-run` records HEAD `a1`, no aggregate exists for round 2, a commit moves HEAD to `b2`, and `spec_review` runs
- **THEN** a new `review-run` for round 2 records `b2` and reviewers are launched for `b2`

#### Scenario: Feedback round kept on a new HEAD
- **WHEN** round 3 is a feedback round recorded at `a1` with no aggregate, a commit moves HEAD to `b2`, and `spec_review` runs
- **THEN** round 3 is aggregated and routed at `a1` with its feedback findings, and the next call starts round 4 at `b2`

### Requirement: Verify every unit at review
The start stage SHALL run every unit's `Verify` at HEAD through the command guard and the `Verify` runner, in body order. A run that is `red` or `invalid` SHALL add a parent finding with severity `CRITICAL`, kind `defect`, location `<first entry of the unit's Files>:1`, the redacted output tail as evidence and scope `unit`. Reviewers SHALL still be launched in that round.

#### Scenario: Red unit at review
- **WHEN** U2's `Verify` exits 1 at HEAD during the start stage
- **THEN** the `review-run` records U2 as red and holds a `CRITICAL` `defect` parent finding at U2's first file

### Requirement: Fan-out
The review stage SHALL launch, at the same time, one reviewer for every selected subject that has no completed reviewer `finding-summary` at HEAD and whose latest run at HEAD did not end `BLOCKED` (a `BLOCKED` run followed by a stuck answer with outcome `approved` or `approved_with_notes` and a chosen option is launched again), through `subagent_dispatch` semantics (packet, launch options, post-launch check, result handling and record), and wait for all of them. The verify stage SHALL do the same for verifiers. Each reviewer SHALL run in a fresh, read-only context whose packet holds none of the implementer's or another reviewer's output. Cancelling the tool call SHALL abort every launched child and record no result for them. Without a capable executor, the stage SHALL launch nothing and return, for each missing run, the `subagent_packet` and `subagent_record` arguments to run inline one at a time; `spec_review` SHALL then be called again.

#### Scenario: Parallel reviewers
- **WHEN** the selected subjects are `change` and `persona:security-auditor` and a capable executor is present
- **THEN** both children are spawned before either is waited for, and each settled run is recorded in its own `finding-summary`

#### Scenario: Inline without an executor
- **WHEN** no capable executor is present and the selected subjects are `change` and `persona:test-engineer`
- **THEN** `spec_review` launches nothing and returns `subagent_packet reviewer change` and `subagent_packet reviewer persona:test-engineer` with their `subagent_record` calls

#### Scenario: Reviewer packet has no other reviewer's output
- **WHEN** the `persona:security-auditor` packet of round 1 is built after the `change` reviewer of round 1 recorded findings
- **THEN** the packet holds no source for the `change` reviewer's `finding-summary`

### Requirement: Reviewer selection
The selected subjects SHALL be the `reviewer` entries of the `review` phase that hold for the change facts: `always` entries always, `auto` entries when a condition holds, where `tags:` conditions read the union of the units' tags and the re-checked tags, `units>=N` reads the unit count, and `context>=N%` never holds. The default pack SHALL declare these `review` entries:
- `reviewer` subject `change`, `always`, skills `[code-review-and-quality]`;
- `reviewer` subject `persona:security-auditor`, `auto`, `when: ["tags:security"]`, skills `[security-and-hardening]`;
- `reviewer` subject `persona:web-performance-auditor`, `auto`, `when: ["tags:perf", "tags:ui"]`, skills `[performance-optimization]`;
- `reviewer` subject `persona:test-engineer`, `auto`, `when: ["units>=3"]`;
- `verifier`, `always`.

#### Scenario: Security tag from the plan
- **WHEN** U1 has tag `security` and the change has 2 units
- **THEN** the selected subjects are `change` and `persona:security-auditor`

#### Scenario: Three units
- **WHEN** the change has 3 units and no tags
- **THEN** the selected subjects are `change` and `persona:test-engineer`

### Requirement: Tags re-checked at review
The start stage SHALL run the `tags` rule over the files of `git diff <Base>..HEAD` (as `Files`, with no title, `Covers` or `Done means` text) and record the tags no unit carries, possibly none, in one `decision` ledger entry `tags.review` with source `rule`, posted every round (the latest wins). These tags SHALL count for reviewer selection. Unit bodies and unit decision records MUST NOT change.

#### Scenario: Auth file without a security tag
- **WHEN** no unit has tag `security` and the change's diff modifies `src/auth/session.ts`
- **THEN** the `tags.review` record holds `security`, `persona:security-auditor` is selected, and no unit's `Tags` line changes

### Requirement: Constraints not weakened
The start stage SHALL check `git diff <Base>..HEAD` and add one parent finding with severity `CRITICAL`, kind `lowered-standard` and scope `unit` for each of:
- an added line with a skip or only marker (`.skip`, `.only`, `xit`, `xdescribe`, `xtest`);
- an added line with `@ts-ignore`, with `@ts-expect-error` followed by no reason, or with `eslint-disable`;
- a deleted file matching the test patterns of `unit-evidence` "Verifier pending";
- a test file whose diff removes more assertion lines (`expect(`, `assert…(`, `.should`) than it adds.
The location SHALL be the path and the new line (the old line for a removal, line 1 for a deleted file). When `specs/constraints.md` exists, the evidence SHALL cite it.

#### Scenario: Added skip
- **WHEN** the diff adds `it.skip("limits", …)` at line 12 of `test/limit.test.ts`
- **THEN** the round holds a `CRITICAL` `lowered-standard` finding at `test/limit.test.ts:12`

#### Scenario: Expect-error with a reason
- **WHEN** the diff adds `// @ts-expect-error: the vendor type is wrong`
- **THEN** no finding is created for that line

#### Scenario: Deleted test file
- **WHEN** the diff deletes `test/old.test.ts`
- **THEN** the round holds a `CRITICAL` `lowered-standard` finding at `test/old.test.ts:1`

### Requirement: Review round cap
`review_rounds` SHALL be derived as the number of aggregate records newer than the latest stuck answer, with outcome `approved` or `approved_with_notes` and a chosen option, to a stuck report sent while the cap blocked; a `counter` entry `review_rounds` MUST be ignored. The cap SHALL block when `review_rounds` has reached `loops.review_rounds`, the latest round is routed, and its aggregate left a blocking finding routed `unit` or `in-change`, whatever HEAD is now. While it blocks, `spec_review` MUST NOT start a new round and the next step SHALL be `spec_stuck`.

#### Scenario: Cap reached
- **WHEN** `loops.review_rounds` is 3, the third round is routed, and its aggregate still has a blocking `unit` finding that unticked U2
- **THEN** the next step asks for a stuck report with `spec_stuck`, not a return to `build`, and `spec_review` refuses to start round 4

#### Scenario: Last round finishes before the cap
- **WHEN** `loops.review_rounds` is 3 and round 3's aggregate is posted but its verifiers have not run
- **THEN** the next step is `spec_review`, which runs the verify and route stages of round 3

#### Scenario: Stuck answer restarts the budget
- **WHEN** after that, a stuck report is answered with outcome `approved` and choice `A`
- **THEN** `review_rounds` reads 0 and `spec_review` may start round 4

### Requirement: Review gate
The `review` phase SHALL have the gate-only check `review-clean`, which passes only when the latest aggregate's `head` is HEAD and none of its findings blocks (see `finding-routing` "Finding status"). `spec_gate review` (a `self` gate) SHALL therefore pass only then, and its `gate` comment's `head_sha` SHALL be the reviewed HEAD.

#### Scenario: Clean round passes the gate
- **WHEN** round 2's aggregate at HEAD `c3` has only a `DISPUTED` finding and a `SUGGESTION`
- **THEN** `spec_gate review` writes an approved `gate` comment with `head_sha` `c3`

#### Scenario: Code changed after review
- **WHEN** round 2's aggregate is clean at `c3` and a commit moves HEAD to `d4`
- **THEN** `spec_gate review` refuses, naming `review-clean`, and the next step is `spec_review`

### Requirement: Review next steps
In the `review` phase, after the checks rule and before the gate, the next step SHALL be, in order:
1. a selected reviewer of a round started at HEAD whose latest run at HEAD ended `BLOCKED`, with no stuck answer newer than that run: `spec_stuck`, naming the subject;
2. a round started at HEAD and not yet routed: `spec_review`, naming the stage it will run and, without a capable executor, the inline runs;
3. the `review_rounds` cap blocking: `spec_stuck`;
4. a pending unit: return to `build` to rebuild it, with `advance: build`;
5. no routed round at HEAD: `spec_review`;
6. the latest aggregate at HEAD has a blocking `in-change` finding: `unit_amend --add` naming its file, or, for a finding at `check:<name>`, naming the failing check and saying to fix it in a unit added with `unit_amend --add`.
A round SHALL be **routed** when its `review-run` record says its route stage completed.

#### Scenario: Back to build
- **WHEN** the change is in `review` and U2 is pending after a `unit` route
- **THEN** the next step says to rebuild U2 and reports `build` as the phase to advance to

#### Scenario: Reviewer blocked
- **WHEN** round 1's `persona:test-engineer` run at HEAD ended `BLOCKED` after its retry
- **THEN** the next step is `spec_stuck`, naming `persona:test-engineer`

#### Scenario: In-change finding
- **WHEN** the latest aggregate at HEAD has a blocking `in-change` finding at `src/util/clock.ts:4`
- **THEN** the next step names `unit_amend --add` and `src/util/clock.ts`

#### Scenario: Failing check finding
- **WHEN** the latest aggregate at HEAD has a blocking `in-change` finding at `check:ci/test` from a pull request feedback round
- **THEN** the next step names `unit_amend --add` and the failing check `ci/test`

### Requirement: Code simplification unit
When the agent read the `code-simplification` skill in `review`, no unit is titled `simplify`, and the latest aggregate at HEAD left nothing blocking, the gate step SHALL first offer adding a unit titled `simplify` with `unit_amend --add`, `Kind: refactor` and the full test suite as `Verify`. Adding it SHALL make a unit pending, so the change returns to `build` and the next round reviews the simplified code.

#### Scenario: Simplify offered
- **WHEN** a skill note records `code-simplification` read in `review` and round 1 at HEAD is clean
- **THEN** the next step offers `unit_amend --add` for a `simplify` unit with `Kind: refactor` before the gate
