## MODIFIED Requirements

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
