# finding-routing Specification

## Purpose

Defines how review findings become work: the aggregate record and de-duplication, adversarial verification and `DISPUTED`, the `finding-scope` rule and `routeFinding`, the effects of each route, pull request review comments and the review result at the ship gate.

## Requirements

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

### Requirement: Finding verification
Each aggregate finding with severity `CRITICAL` or `WARNING` SHALL be sent to the `verifier` role, which tries to refute it, except a `missed-context` finding and a parent finding, which SHALL block without verification. A finding SHALL be `DISPUTED` when its latest completed verifier record has verdict `refuted`; a `DISPUTED` finding MUST NOT block. A verifier run at HEAD that ends `BLOCKED` after the dispatch's own retries SHALL count as confirming the finding (fail closed); any other incomplete run SHALL be dispatched again by the next `spec_review`. The `findings` a verifier returns SHALL be ignored. The route stage SHALL run only when every finding that needs verification has a completed verifier record or a `BLOCKED` one. When the pack's `review` `verifier` entry has `mode: off`, no finding SHALL be verified and every blocking finding stays blocking.

#### Scenario: Refuted finding
- **WHEN** the verifier of aggregate finding 0 returns `DONE` with verdict `refuted` and every required source used
- **THEN** finding 0 is `DISPUTED` and does not block `spec_gate review`

#### Scenario: Confirmed finding
- **WHEN** the verifier of aggregate finding 1 returns verdict `confirmed`
- **THEN** finding 1 blocks as routed

#### Scenario: Missed context skips the verifier
- **WHEN** the aggregate holds a `WARNING` `missed-context` finding
- **THEN** no verifier is launched for it and it blocks

#### Scenario: Verifier blocked
- **WHEN** the verifier of finding 2 ends `BLOCKED` after its retry
- **THEN** finding 2 is routed and blocks as a confirmed finding

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
- `question`: a non-blocking question, raised by livespec code through `spec_question`, with text naming `finding:<aggregateRef>:<index>`, where `<aggregateRef>` is the aggregate entry's `ref`, the candidates `apply the proposed fix` ("The agent applies the reviewer's proposed fix in this change.") and `leave it out of this change` ("The finding is not fixed in this change."), the first recommended with the rationale `The reviewer proposed a fix; applying it keeps the change consistent.`, unless a question already names that key;
- `record`: nothing.

#### Scenario: Unit unticked
- **WHEN** a confirmed `CRITICAL` finding is routed to U2 and U2 is done
- **THEN** a `rebuild.U2.<round>` comment is posted, U2's status line is unticked, U2's next implementer packet lists the finding, and the next step in `build` is `unit_start U2`, not `unit_finish U2`

#### Scenario: Question raised once
- **WHEN** the route stage runs twice for a `question` finding
- **THEN** exactly one question names that finding

#### Scenario: Routing question carries candidates
- **WHEN** a `needs-decision` finding is routed `question`
- **THEN** the question is `(non-blocking)`, and its request offers `apply the proposed fix` first, recommended, and `leave it out of this change`; either answer resolves the finding as before

#### Scenario: Out of scope does not block
- **WHEN** the only blocking finding of the latest aggregate at HEAD is routed `out-of-scope`
- **THEN** `spec_gate review` passes and the ship gate payload lists the finding as a follow-up

### Requirement: Finding status
An aggregate finding SHALL block the review gate when it is `CRITICAL` or `WARNING` or of kind `missed-context`, is not `DISPUTED`, is not rebutted (a `missed-context` finding cannot be rebutted), and is routed:
- `unit` or `in-change`: always, for the aggregate it belongs to; a later round's aggregate is judged on its own findings;
- `question`: until the question naming it is answered;
- `out-of-scope` or `record`: never.
A finding that needs verification and has no completed verifier record SHALL block.

#### Scenario: Unverified finding blocks
- **WHEN** the aggregate at HEAD holds a `WARNING` `unit` finding and no verifier record for it
- **THEN** `review-clean` fails

#### Scenario: Answered question
- **WHEN** a `question` finding's question is answered
- **THEN** it no longer blocks

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

### Requirement: Review result at the ship gate
The `ship` gate payload SHALL hold, through `registerGatePayload`, the review result of the latest routed round: its round number and HEAD, each `DISPUTED` finding with the verifier's reason, each rebutted finding, each `out-of-scope` follow-up, and each reviewer subject whose run was inline.

#### Scenario: Disputed and inline at ship
- **WHEN** round 2 has one `DISPUTED` finding and the `change` reviewer ran inline
- **THEN** the ship gate payload lists round 2, the disputed finding with the verifier's reason, and `change` as an inline review

#### Scenario: Rebutted aggregate finding
- **WHEN** the parent rebuts aggregate finding 1, a `WARNING` `defect`, with `finding_rebut` and evidence
- **THEN** the finding no longer blocks `review-clean` and the ship gate payload lists the rebuttal
