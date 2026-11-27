## MODIFIED Requirements

### Requirement: Aggregate findings
The aggregate stage SHALL append one `finding-summary` ledger entry with id `finding-summary.change.review.<round>`, marked `aggregate: true`, holding the round, HEAD, the entry refs of the round's completed reviewer summaries, and the aggregate findings. It SHALL be posted only when every selected subject has a completed reviewer summary at HEAD. Aggregate findings SHALL be the parent findings of the `review-run` and the reviewers' findings, de-duplicated by normalized path, line and kind: a merged finding SHALL keep the highest severity, the first evidence and fix, the keys of every finding it merged, and the `needs-decision` mark when any merged finding had scope `needs-decision`. Each aggregate finding SHALL also hold its route (see "Finding scope rule") and whether it needs verification. An aggregate record MUST NOT count as a reviewer round, a unit review or a completed review of any subject.

#### Scenario: Two reviewers, one defect
- **WHEN** the `change` reviewer reports a `WARNING` `defect` at `src/limit.ts:10` and the security persona reports a `CRITICAL` `defect` at `./src/limit.ts:10`
- **THEN** the aggregate holds one `CRITICAL` `defect` finding at `src/limit.ts:10` with both source keys

#### Scenario: Same file, other line
- **WHEN** two reviewers report `defect` findings at `src/limit.ts:10` and `src/limit.ts:40`
- **THEN** the aggregate holds two findings

#### Scenario: Reviewer still missing
- **WHEN** the `change` reviewer completed at HEAD and the selected `persona:test-engineer` has no completed summary at HEAD
- **THEN** no aggregate is posted and the next step is `spec_review`

### Requirement: Finding scope rule
The `finding-scope` decision point SHALL be registered with `registerRule` and configured as `decisions.finding-scope: { mode: rule }` in the default pack. `routeFinding(finding, facts)` SHALL be exported and SHALL compute the route from facts built by code (the finding's path, every unit's id and `Files`, the change diff's files including deleted files and both paths of a rename, whether the finding is marked `needs-decision`, its kind, its severity and whether its location names a CI check), never from the reviewer's `scope`, in this order:
1. `SUGGESTION` of a kind other than `missed-context` → `record`;
2. marked `needs-decision` → `question`;
3. the location is a CI check (`check:<name>`) → `in-change`;
4. the path matches a unit's `Files` (exact or glob) → `unit`, with the first such unit in body order;
5. the path is in the diff, or the kind is `missed-context` → `in-change`;
6. otherwise → `out-of-scope`.
The rule MUST NOT ask a human. The aggregate stage SHALL append one `decision` entry `finding-scope.review-<round>` whose outcome maps each aggregate finding's index to its route and unit.

#### Scenario: Seeded defect routed to its unit
- **WHEN** a reviewer reports a `WARNING` with scope `out-of-scope` at `src/limit.ts:10`, and U2's `Files` list `src/limit.ts`
- **THEN** the finding's route is `unit` with unit `U2`

#### Scenario: Changed file outside every unit
- **WHEN** a finding is at `src/util/clock.ts:4`, which the diff modifies and no unit lists
- **THEN** its route is `in-change`

#### Scenario: Untouched file
- **WHEN** a finding is at `src/legacy.ts:1`, which the diff does not modify
- **THEN** its route is `out-of-scope`

#### Scenario: Deleted test file stays in the change
- **WHEN** the parent finding for the deleted `test/old.test.ts` is at a file no unit lists
- **THEN** its route is `in-change` and it blocks the review gate

#### Scenario: Missed context outside the diff
- **WHEN** a `SUGGESTION` `missed-context` finding is at `config/limits.yaml:1`, which the diff does not modify and no unit lists
- **THEN** its route is `in-change` and it blocks the review gate

#### Scenario: Suggestion
- **WHEN** a `SUGGESTION` is at a file U1 lists
- **THEN** its route is `record`

#### Scenario: Failing check
- **WHEN** a `CRITICAL` `defect` finding is at `check:ci/test`
- **THEN** its route is `in-change`

### Requirement: Route effects
The route stage SHALL apply, idempotently, for every aggregate finding that is not `DISPUTED`:
- `unit`: post one own `rebuild` comment with id `rebuild.<unit>.<round>` naming the finding, then untick the unit when it is done, and list the finding in that unit's next implementer packet;
- `in-change`: nothing, the next step names `unit_amend --add`;
- `out-of-scope`: nothing, the finding is listed as a follow-up in the aggregate and at the next human gate until a gate has shown it;
- `question`: `spec_question` with text naming `finding:<aggregateRef>:<index>`, where `<aggregateRef>` is the aggregate entry's `ref`, unless a question already names that key;
- `record`: nothing.

#### Scenario: Unit unticked
- **WHEN** a confirmed `CRITICAL` finding is routed to U2 and U2 is done
- **THEN** a `rebuild.U2.<round>` comment is posted, U2's status line is unticked, U2's next implementer packet lists the finding, and the next step in `build` is `unit_start U2`, not `unit_finish U2`

#### Scenario: Question raised once
- **WHEN** the route stage runs twice for a `question` finding
- **THEN** exactly one question names that finding

#### Scenario: Out of scope does not block
- **WHEN** the only blocking finding of the latest aggregate at HEAD is routed `out-of-scope`
- **THEN** `spec_gate review` passes and the ship gate payload lists the finding as a follow-up

### Requirement: Pull request review comments
When an open pull request exists for the change branch, the route stage SHALL post each aggregate finding that is not `DISPUTED`, other than `record`, as a pull request review comment at its path and line, carrying a hidden marker with its aggregate key. A finding whose marker already appears in the pull request's review comments MUST NOT be posted again. A finding the forge rejects SHALL stay in the aggregate only, and the tool result SHALL name it. With no pull request, findings SHALL appear only in the aggregate ledger entry. The findings of a round whose `review-run` has `source: pull-request` (see pull-request-feedback) MUST NOT be posted as review comments.

#### Scenario: No pull request
- **WHEN** the change branch has no open pull request
- **THEN** no review comment is posted and the aggregate holds every finding

#### Scenario: Retried stage
- **WHEN** a pull request is open and the route stage runs twice
- **THEN** each finding has exactly one review comment

#### Scenario: Feedback round not posted back
- **WHEN** the route stage runs for a round whose `review-run` has `source: pull-request`
- **THEN** no review comment is posted for its findings
